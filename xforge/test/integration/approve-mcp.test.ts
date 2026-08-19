import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';
import { APPROVAL_LIFETIME_HOURS } from '../../src/commands/approve.js';

const fixtureServer = fileURLToPath(new URL('../fixtures/mcp-approval-server.mjs', import.meta.url));
/** Answers poll_approval with whatever body the test dictates, including ones XForge must refuse. */
const rawFixtureServer = fileURLToPath(new URL('../fixtures/mcp-approval-raw-server.mjs', import.meta.url));

/** What the fixture servers need to read their scripted decision out of the environment. */
const FIXTURE_ENV_ALLOW = ['XFORGE_TEST_MCP_EXPECTED_VALUE', 'XFORGE_TEST_MCP_DECISION', 'XFORGE_TEST_MCP_APPROVER_ID', 'XFORGE_TEST_MCP_APPROVER_ROLE', 'XFORGE_TEST_MCP_POLL_BODY', 'XFORGE_TEST_MCP_POLL_PAD'];

async function toDesignWithMcpProvider(
  root: string,
  env: { allow?: string[]; allowPrefixes?: string[] } = { allow: FIXTURE_ENV_ALLOW },
  server = fixtureServer,
): Promise<void> {
  await createCompleteSolidChange(root);
  expect((await runCli(root, ['install'])).code).toBe(0);
  expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
  expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);

  // mcp-approval.ts allowlists the provider subprocess's environment (it no longer inherits the
  // ambient environment wholesale); the test-only fake platform reads its scripted decision out of
  // these XFORGE_TEST_MCP_* vars (see fixtures/mcp-approval-server.mjs), so this fixture declares
  // them via spec.env.allow the same way a real provider would opt in to what it actually needs.
  // `env` is a parameter so individual tests can swap in an allowPrefixes declaration, or add a
  // name the deny filter is expected to drop anyway.
  // XFORGE_TEST_MCP_TOKEN itself doesn't need to be listed: it's consumed by the CLI process via
  // authTokenEnv and handed to the subprocess as XFORGE_MCP_TOKEN, not passed through by name.
  // (XFORGE_TEST_MCP_EXPECTED_VALUE is deliberately not named "...TOKEN": the allowlist's
  // credential-shaped deny pattern would drop it even when listed here.)
  await write(root, 'xforge/scaffold/mcp-servers/review-bot.yaml', [
    'apiVersion: xforge.dev/v1alpha2',
    'kind: McpServer',
    'metadata: { name: review-bot, version: 1 }',
    'spec:',
    '  transport: stdio',
    `  command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(server)}]`,
    '  authTokenEnv: XFORGE_TEST_MCP_TOKEN',
    '  timeoutSeconds: 10',
    '  env:',
    ...(env.allow ? [`    allow: ${JSON.stringify(env.allow)}`] : []),
    ...(env.allowPrefixes ? [`    allowPrefixes: ${JSON.stringify(env.allowPrefixes)}`] : []),
    '',
  ].join('\n'));

  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
    manifest.scaffold.mcpServers = ['review-bot'];
    manifest.approvals.providers.push({ id: 'review-bot', type: 'mcp', mcpServer: 'review-bot', roles: ['owner', 'maintainer'] });
  });
  await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
    const policy = flow.governance.approvalPolicies.find((item: any) => item.id === 'planning-solid');
    policy.providers.push('review-bot');
  });
}

/*
 * `--for check`, not `--for apply`. `planning-solid` gates the *design* Stage's exit, and the design
 * exit transitions to `check`; a receipt filed against `apply` is bound to a transition this Change
 * cannot take from here, so `approvalsForPolicy` would never count it. This fixture said `apply` for
 * fifteen tests and they all passed, because each asserted only that a receipt was written — which
 * is exactly the hole `assertApprovableTransition` now closes, found in our own suite by closing it.
 */
const mcpApproveArgs = ['approve', '--change', 'add-feature', '--for', 'check', '--policy', 'planning-solid', '--provider', 'review-bot'];

describe('mcp approval provider', () => {
  it('submits and polls to a decided approval, writing an unsigned receipt', async () => {
    const root = await fixture();
    await toDesignWithMcpProvider(root);
    const result = await runCli(root, mcpApproveArgs, {
      XFORGE_TEST_MCP_TOKEN: 'shared-secret', XFORGE_TEST_MCP_EXPECTED_VALUE: 'shared-secret',
      XFORGE_TEST_MCP_DECISION: 'approve', XFORGE_TEST_MCP_APPROVER_ID: 'alice@example.test', XFORGE_TEST_MCP_APPROVER_ROLE: 'owner',
    });
    expect(result.code).toBe(0);
    expect(result.json.data.receipt.approver).toEqual({ id: 'alice@example.test', provider: 'review-bot', role: 'owner', type: 'external-system' });
    expect(result.json.data.receipt.signature).toBeUndefined();
    /*
     * The fixture sends no expiresAt, as a provider is entitled to. control-plane.ts reads an absent
     * expiresAt as "never expires", so inheriting that omission would let a provider that simply
     * forgot one optional field mint a permanently valid approval — stronger than anything the local
     * path can issue. The default lifetime applies to provider receipts too.
     */
    const expiresAt = Date.parse(result.json.data.receipt.expiresAt);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + APPROVAL_LIFETIME_HOURS * 3_600_000);
  });

  it('keeps a provider-supplied expiry instead of overriding it with the default', async () => {
    const root = await fixture();
    await toDesignWithMcpProvider(root, { allow: FIXTURE_ENV_ALLOW }, rawFixtureServer);
    const providerExpiry = new Date(Date.now() + 3_600_000).toISOString();
    const result = await runCli(root, mcpApproveArgs, {
      XFORGE_TEST_MCP_TOKEN: 'shared-secret',
      XFORGE_TEST_MCP_POLL_BODY: JSON.stringify({
        status: 'decided', decision: 'approve', approver: { id: 'alice@example.test', role: 'owner' },
        reason: 'Decided upstream.', expiresAt: providerExpiry,
      }),
    });
    expect(result.code, JSON.stringify(result.json?.diagnostics)).toBe(0);
    expect(result.json.data.receipt.expiresAt).toBe(providerExpiry);
  });

  /*
   * P2-4: a decision that has not been made yet is a state, not a command failure. The caller gets a
   * successful envelope with a pending next action instead of an error it has to pattern-match, and
   * still nothing is written.
   */
  it('returns a pending next action without writing anything when the decision is not in yet', async () => {
    const root = await fixture();
    await toDesignWithMcpProvider(root);
    const result = await runCli(root, mcpApproveArgs, {
      XFORGE_TEST_MCP_TOKEN: 'shared-secret', XFORGE_TEST_MCP_EXPECTED_VALUE: 'shared-secret', XFORGE_TEST_MCP_DECISION: 'pending',
    });
    expect(result.code).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.data).toMatchObject({ status: 'pending', receipt: null, policy: 'planning-solid' });
    expect(result.json.changes).toEqual([]);
    const pending = result.json.nextActions.find((item: any) => item.action === 'await-approval');
    expect(pending).toMatchObject({ status: 'pending', id: 'planning-solid', type: 'approval' });
    /* The resume command is this invocation re-emitted, so it carries the same `--for`. */
    expect(pending.command).toEqual(['xforge', ...mcpApproveArgs]);
    const state = await runCli(root, ['state', '--change', 'add-feature']);
    expect(state.json.data.change.governance.pendingApprovals.some((item: any) => item.policyId === 'planning-solid')).toBe(true);
  });

  /*
   * The three tests below pin the security invariant itself, not just the happy path: the fixture
   * server exits non-zero if a forbidden variable reaches it (see fixtures/mcp-approval-server.mjs),
   * so a leak shows up as XFORGE_APPROVAL_MCP_CONNECTION_FAILED rather than a silent pass. Each one
   * therefore asserts a *successful* approval — success means the variable never arrived.
   */
  it('does not pass an undeclared ambient variable through to the provider subprocess', async () => {
    const root = await fixture();
    await toDesignWithMcpProvider(root);
    const result = await runCli(root, mcpApproveArgs, {
      XFORGE_TEST_MCP_TOKEN: 'shared-secret', XFORGE_TEST_MCP_EXPECTED_VALUE: 'shared-secret',
      XFORGE_TEST_MCP_DECISION: 'approve', XFORGE_TEST_MCP_APPROVER_ID: 'alice@example.test', XFORGE_TEST_MCP_APPROVER_ROLE: 'owner',
      // Present in the CLI's own environment, absent from this McpServer's spec.env.allow.
      XFORGE_TEST_MCP_FORBIDDEN_LEAK: 'leaked',
    });
    expect(result.code).toBe(0);
    expect(result.json.data.receipt.approver.id).toBe('alice@example.test');
  });

  /*
   * Deny beats allow: a manifest cannot opt a credential-shaped name back in. Also pins the bounded
   * diagnostic — the filtered-variable report counts credential-shaped exclusions but never names
   * them, so this envelope (which lands in agent context and CI logs) is not an inventory of the
   * machine's secret-ish variable names.
   */
  it('drops a credential-shaped variable even when the McpServer explicitly allows it', async () => {
    const root = await fixture();
    await toDesignWithMcpProvider(root, { allow: [...FIXTURE_ENV_ALLOW, 'XFORGE_TEST_MCP_AUTH_BACKDOOR'] });
    const result = await runCli(root, mcpApproveArgs, {
      XFORGE_TEST_MCP_TOKEN: 'shared-secret', XFORGE_TEST_MCP_EXPECTED_VALUE: 'shared-secret',
      XFORGE_TEST_MCP_DECISION: 'approve', XFORGE_TEST_MCP_APPROVER_ID: 'alice@example.test', XFORGE_TEST_MCP_APPROVER_ROLE: 'owner',
      XFORGE_TEST_MCP_AUTH_BACKDOOR: 'backdoor',
    });
    expect(result.code).toBe(0);
    expect(result.json.data.receipt.approver.id).toBe('alice@example.test');
    const filteredDiagnostic = result.json.diagnostics.find((item: any) => item.code === 'XFORGE_APPROVAL_MCP_ENV_FILTERED');
    expect(filteredDiagnostic).toBeDefined();
    expect(filteredDiagnostic.message).not.toContain('XFORGE_TEST_MCP_AUTH_BACKDOOR');
    expect(filteredDiagnostic.message).not.toContain('XFORGE_TEST_MCP_TOKEN');
  });

  /*
   * spec.env.allowPrefixes: a provider needing a family of variables declares the family, not every
   * member. Nothing here is listed in spec.env.allow, so the fixture only receives its scripted
   * decision if prefix matching works — a broken prefix path shows up as a 'pending' result. The
   * credential-shaped name is set too: a matching prefix must not beat the deny filter either.
   */
  it('passes variables declared via allowPrefixes through, while the deny filter still wins', async () => {
    const root = await fixture();
    await toDesignWithMcpProvider(root, { allowPrefixes: ['XFORGE_TEST_MCP_'] });
    const result = await runCli(root, mcpApproveArgs, {
      XFORGE_TEST_MCP_TOKEN: 'shared-secret', XFORGE_TEST_MCP_EXPECTED_VALUE: 'shared-secret',
      XFORGE_TEST_MCP_DECISION: 'approve', XFORGE_TEST_MCP_APPROVER_ID: 'prefixed@example.test', XFORGE_TEST_MCP_APPROVER_ROLE: 'owner',
      XFORGE_TEST_MCP_AUTH_BACKDOOR: 'backdoor',
    });
    expect(result.code).toBe(0);
    expect(result.json.data.receipt.approver).toEqual({ id: 'prefixed@example.test', provider: 'review-bot', role: 'owner', type: 'external-system' });
  });

  /*
   * A poll result is third-party input that this command turns straight into a written receipt and
   * an audit-chain event, so every shape it can arrive in has to be decided here rather than
   * discovered by dereferencing it. These pin the two ends of that: XForge never acts on a body it
   * does not understand, and when it refuses it says so as a provider problem the operator can fix
   * — not as XFORGE_INTERNAL_ERROR, which reads as an XForge bug and tells them nothing.
   */
  describe('malformed poll_approval responses', () => {
    async function pollWith(body: string, environment: NodeJS.ProcessEnv = {}): Promise<any> {
      const root = await fixture();
      await toDesignWithMcpProvider(root, { allow: FIXTURE_ENV_ALLOW }, rawFixtureServer);
      const result = await runCli(root, mcpApproveArgs, {
        XFORGE_TEST_MCP_TOKEN: 'shared-secret', XFORGE_TEST_MCP_POLL_BODY: body, ...environment,
      });
      return { root, result };
    }

    /*
     * The regression this test exists for: a decided body with no approver used to skip the pending
     * branch and then dereference poll.approver.role, throwing a TypeError that surfaced as
     * XFORGE_INTERNAL_ERROR. Fail-closed, but it blamed XForge for the provider's bug.
     */
    it('reports a decided result with no approver as a provider problem, not an internal error', async () => {
      const { result } = await pollWith(JSON.stringify({ status: 'decided', decision: 'approve', reason: 'No approver field.' }));
      expect(result.code).toBe(1);
      const codes = result.json.diagnostics.map((item: any) => item.code);
      expect(codes).toContain('XFORGE_APPROVAL_MCP_RESPONSE_INVALID');
      expect(codes).not.toContain('XFORGE_INTERNAL_ERROR');
      expect(result.json.nextActions[0]).toMatchObject({ action: 'resolve-approval-provider', actor: 'human' });
      expect(result.json.changes).toEqual([]);
    });

    it('refuses an approver with an empty id rather than recording an anonymous approval', async () => {
      const { result } = await pollWith(JSON.stringify({
        status: 'decided', decision: 'approve', approver: { id: '   ', role: 'owner' }, reason: 'Nobody.',
      }));
      expect(result.code).toBe(1);
      expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_APPROVAL_MCP_RESPONSE_INVALID');
    });

    /* An unrecognised status is not "not pending, therefore decided". */
    it('refuses an unknown status instead of treating it as a decision', async () => {
      const { result } = await pollWith(JSON.stringify({
        status: 'awaiting-quorum', decision: 'approve', approver: { id: 'alice@example.test', role: 'owner' }, reason: 'Partial.',
      }));
      expect(result.code).toBe(1);
      expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_APPROVAL_MCP_RESPONSE_INVALID');
    });

    it('refuses a decision word that is neither approve nor reject', async () => {
      const { result } = await pollWith(JSON.stringify({
        status: 'decided', decision: 'approved', approver: { id: 'alice@example.test', role: 'owner' }, reason: 'Typo upstream.',
      }));
      expect(result.code).toBe(1);
      expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_APPROVAL_MCP_RESPONSE_INVALID');
    });

    /* An unparseable expiresAt is rejected at ingestion, not left to fail every later evaluation. */
    it('refuses an expiresAt that is not a parseable date-time', async () => {
      const { result } = await pollWith(JSON.stringify({
        status: 'decided', decision: 'approve', approver: { id: 'alice@example.test', role: 'owner' },
        reason: 'Decided upstream.', expiresAt: 'whenever',
      }));
      expect(result.code).toBe(1);
      expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_APPROVAL_MCP_RESPONSE_INVALID');
    });

    /* approval-receipt.schema.json requires a non-empty reason, so accepting a missing one here
       would only move the failure to the next read of a receipt already written to disk. */
    it('refuses a decided result with no reason', async () => {
      const { result } = await pollWith(JSON.stringify({
        status: 'decided', decision: 'approve', approver: { id: 'alice@example.test', role: 'owner' },
      }));
      expect(result.code).toBe(1);
      expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_APPROVAL_MCP_RESPONSE_INVALID');
    });

    it('refuses a response that is not a JSON object at all', async () => {
      const { result } = await pollWith('["decided"]');
      expect(result.code).toBe(1);
      expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_APPROVAL_MCP_RESPONSE_INVALID');
    });

    /*
     * Over the size cap the text is never handed to JSON.parse, so this surfaces through the
     * transport-failure path rather than the shape check. The assertion is deliberately about the
     * outcome rather than the wording: whichever layer refuses an unbounded provider response
     * first, an oversized body must never become an approval, and must never be reported as an
     * XForge internal error.
     */
    it('never turns a response past the size cap into an approval', async () => {
      const root = await fixture();
      await toDesignWithMcpProvider(root, { allow: FIXTURE_ENV_ALLOW }, rawFixtureServer);
      const result = await runCli(root, mcpApproveArgs, {
        XFORGE_TEST_MCP_TOKEN: 'shared-secret', XFORGE_TEST_MCP_POLL_PAD: String(512 * 1024),
      });
      expect(result.code).toBe(1);
      expect(result.json.data).toBeNull();
      const codes = result.json.diagnostics.map((item: any) => item.code);
      expect(codes.some((code: string) => code.startsWith('XFORGE_APPROVAL_MCP_'))).toBe(true);
      expect(codes).not.toContain('XFORGE_INTERNAL_ERROR');
    });
  });

  it('fails after retrying a few times when the server cannot be reached', async () => {
    const root = await fixture();
    await toDesignWithMcpProvider(root);
    await updateYaml(root, 'xforge/scaffold/mcp-servers/review-bot.yaml', (server) => {
      server.spec.command = ['/nonexistent/xforge-test-binary'];
    });
    const result = await runCli(root, mcpApproveArgs, { XFORGE_TEST_MCP_TOKEN: 'shared-secret' });
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.some((item: any) => item.code === 'XFORGE_APPROVAL_MCP_CONNECTION_FAILED')).toBe(true);
  });
});
