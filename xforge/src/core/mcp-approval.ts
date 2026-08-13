import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CLI_NAME, CLI_VERSION } from '../constants.js';
import type { Diagnostic, GovernanceRevision, McpServerResource, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from './errors.js';
import { filterEnvironment } from './env-safety.js';
import { safeResolve } from './path-safety.js';

const CONNECT_ATTEMPTS = 3;
const CONNECT_BACKOFF_MS = 1000;

export interface McpApprovalSubmission {
  change: string;
  flow: string;
  stage: string;
  transition: string;
  policyId: string;
  revision: GovernanceRevision;
  governingDigest: string;
  roles: string[];
  reason: string;
}

export type McpApprovalPoll =
  | { status: 'pending' }
  | { status: 'decided'; decision: 'approve' | 'reject'; approver: { id: string; role: string }; reason: string; expiresAt?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The `stdio` transport spawns the provider as a child process, so — like Gates and project
 * Scripts (core/env-safety.ts) — it never inherits the ambient environment wholesale: a
 * third-party approval provider is an external process, and a blanket `...process.env` passthrough
 * would hand it cloud credentials, tokens, and anything else sitting in the CLI's environment. Only
 * the built-in safe-default allowlist plus whatever this McpServer's `spec.env.allow` declares is
 * passed through; `XFORGE_MCP_TOKEN` is the deliberate credential handoff to the provider.
 */
function stdioEnvironment(server: McpServerResource, token: string): { env: Record<string, string>; filtered: string[] } {
  const { env, filtered } = filterEnvironment({ allow: server.spec.env?.allow });
  return { env: { ...env, XFORGE_MCP_TOKEN: token }, filtered };
}

async function buildTransport(project: ProjectContext, server: McpServerResource, token: string, env: Record<string, string>) {
  if (server.spec.transport === 'stdio') {
    const [command, ...args] = server.spec.command!;
    const cwd = server.spec.cwd ? await safeResolve(project.root, server.spec.cwd) : project.root;
    return new StdioClientTransport({ command: command!, args, cwd, env });
  }
  return new StreamableHTTPClientTransport(new URL(server.spec.url!), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
}

async function callToolJson<T>(client: Client, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  if (result.isError) throw new Error(`MCP tool ${name} returned an error result.`);
  const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error(`MCP tool ${name} returned no text content to parse.`);
  return JSON.parse(text) as T;
}

/**
 * Connects to `server`, runs `fn` against the live session, and closes the connection.
 * The whole (connect + fn) unit is retried up to CONNECT_ATTEMPTS times on any failure —
 * safe because submit_approval_request is idempotent (keyed by governingDigest) and
 * poll_approval is a pure read.
 *
 * Alongside the caller's result, this returns `diagnostics`: an info-severity entry naming how
 * many ambient environment variables were filtered out of the provider subprocess's environment
 * (see `stdioEnvironment` above), so a human debugging a provider that misbehaves after this
 * allowlisting lands sees why, instead of a bare, unexplained connection failure. Empty when the
 * transport is `http` (no subprocess) or nothing was filtered.
 */
export async function withMcpApprovalSession<T>(
  project: ProjectContext,
  server: McpServerResource,
  providerId: string,
  fn: (client: Client, timeoutMs: number) => Promise<T>,
): Promise<{ result: T; diagnostics: Diagnostic[] }> {
  const token = process.env[server.spec.authTokenEnv];
  if (!token) throw new XForgeError(diagnostic('XFORGE_APPROVAL_MCP_TOKEN_MISSING', `MCP auth token environment is unavailable: ${server.spec.authTokenEnv}.`), {
    nextActions: [{
      action: 'set-mcp-auth-token', actor: 'human',
      reason: `McpServer "${server.metadata.name}" requires its auth token in the environment variable named by authTokenEnv: ${server.spec.authTokenEnv}. Set that environment variable to a credential the provider accepts before retrying.`,
    }],
  });
  const timeoutMs = server.spec.timeoutSeconds * 1000;
  const diagnostics: Diagnostic[] = [];
  /* Deterministic for the lifetime of this call (process.env and the spec don't change between
   * retries), so it's computed once and reused across connection attempts below. */
  const stdio = server.spec.transport === 'stdio' ? stdioEnvironment(server, token) : null;
  if (stdio && stdio.filtered.length > 0) {
    diagnostics.push(diagnostic(
      'XFORGE_APPROVAL_MCP_ENV_FILTERED',
      `${stdio.filtered.length} ambient environment variable(s) were not passed through to MCP provider ${providerId}'s subprocess: ${stdio.filtered.join(', ')}. Declare any the provider actually needs under this McpServer's spec.env.allow.`,
      undefined,
      'info',
    ));
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    const client = new Client({ name: CLI_NAME, version: CLI_VERSION }, { capabilities: {} });
    try {
      const transport = await buildTransport(project, server, token, stdio?.env ?? {});
      await client.connect(transport, { timeout: timeoutMs });
      try {
        return { result: await fn(client, timeoutMs), diagnostics };
      } finally {
        await client.close();
      }
    } catch (error) {
      lastError = error;
      await client.close().catch(() => {});
      if (attempt < CONNECT_ATTEMPTS) await sleep(CONNECT_BACKOFF_MS * attempt);
    }
  }
  throw new XForgeError(diagnostic(
    'XFORGE_APPROVAL_MCP_CONNECTION_FAILED',
    `Could not complete the request against MCP provider ${providerId} after ${CONNECT_ATTEMPTS} attempts: ${(lastError as Error)?.message ?? 'unknown error'}.`,
  ), {
    nextActions: [{
      action: 'resolve-approval-provider', actor: 'human',
      reason: `MCP provider ${providerId} (McpServer "${server.metadata.name}") was unreachable after ${CONNECT_ATTEMPTS} attempts. This looks like a configuration or infrastructure problem, not a transient failure to retry blindly — check that the provider process/endpoint is actually deployed and that this McpServer resource's transport, command/url, and network access are configured correctly.`,
      command: ['xforge', 'doctor'],
    }],
  });
}

export async function submitApprovalRequest(client: Client, timeoutMs: number, input: McpApprovalSubmission): Promise<void> {
  await callToolJson<{ accepted?: boolean }>(client, 'submit_approval_request', input as unknown as Record<string, unknown>, timeoutMs);
}

export async function pollApproval(client: Client, timeoutMs: number, governingDigest: string): Promise<McpApprovalPoll> {
  return callToolJson<McpApprovalPoll>(client, 'poll_approval', { governingDigest }, timeoutMs);
}
