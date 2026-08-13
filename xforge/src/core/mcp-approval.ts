import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CLI_NAME, CLI_VERSION } from '../constants.js';
import type { GovernanceRevision, McpServerResource, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from './errors.js';
import { safeResolve } from './path-safety.js';
import { buildSubprocessEnvironment } from './subprocess-env.js';

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

async function buildTransport(project: ProjectContext, server: McpServerResource, token: string) {
  if (server.spec.transport === 'stdio') {
    const [command, ...args] = server.spec.command!;
    const cwd = server.spec.cwd ? await safeResolve(project.root, server.spec.cwd) : project.root;
    /* The approval server is an external process; it must not inherit the ambient environment any
       more than a Gate does. `env.allow` / `env.allowPrefixes` opt extra variables in — the token
       itself is always injected under XFORGE_MCP_TOKEN, bypassing the credential-shaped-name deny. */
    const env = buildSubprocessEnvironment({
      allow: server.spec.env?.allow,
      allowPrefixes: server.spec.env?.allowPrefixes,
      force: { XFORGE_MCP_TOKEN: token },
    });
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
 */
export async function withMcpApprovalSession<T>(
  project: ProjectContext,
  server: McpServerResource,
  providerId: string,
  fn: (client: Client, timeoutMs: number) => Promise<T>,
): Promise<T> {
  const token = process.env[server.spec.authTokenEnv];
  if (!token) {
    throw new XForgeError(
      diagnostic('XFORGE_APPROVAL_MCP_TOKEN_MISSING', `MCP auth token environment is unavailable: ${server.spec.authTokenEnv}.`),
      { nextActions: [{ action: 'configure-approval-token', type: 'approval', actor: 'human', reason: `Set the ${server.spec.authTokenEnv} environment variable with the approval system's token (see scaffold/mcp-servers/enterprise-approvals.yaml), or approve locally on the terminal.` }] },
    );
  }
  const timeoutMs = server.spec.timeoutSeconds * 1000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    const client = new Client({ name: CLI_NAME, version: CLI_VERSION }, { capabilities: {} });
    try {
      const transport = await buildTransport(project, server, token);
      await client.connect(transport, { timeout: timeoutMs });
      try {
        return await fn(client, timeoutMs);
      } finally {
        await client.close();
      }
    } catch (error) {
      lastError = error;
      await client.close().catch(() => {});
      if (attempt < CONNECT_ATTEMPTS) await sleep(CONNECT_BACKOFF_MS * attempt);
    }
  }
  throw new XForgeError(
    diagnostic(
      'XFORGE_APPROVAL_MCP_CONNECTION_FAILED',
      `Could not complete the request against MCP provider ${providerId} after ${CONNECT_ATTEMPTS} attempts: ${(lastError as Error)?.message ?? 'unknown error'}.`,
    ),
    { nextActions: [{ action: 'verify-approval-server', type: 'approval', actor: 'human', reason: `The MCP provider ${providerId} is unreachable. Configure or replace the approval system's server command or URL and make sure ${server.spec.authTokenEnv} is set (see scaffold/mcp-servers/enterprise-approvals.yaml), or approve locally on the terminal.` }] },
  );
}

export async function submitApprovalRequest(client: Client, timeoutMs: number, input: McpApprovalSubmission): Promise<void> {
  await callToolJson<{ accepted?: boolean }>(client, 'submit_approval_request', input as unknown as Record<string, unknown>, timeoutMs);
}

export async function pollApproval(client: Client, timeoutMs: number, governingDigest: string): Promise<McpApprovalPoll> {
  return callToolJson<McpApprovalPoll>(client, 'poll_approval', { governingDigest }, timeoutMs);
}
