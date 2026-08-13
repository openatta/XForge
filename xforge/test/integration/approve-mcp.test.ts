import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

const fixtureServer = fileURLToPath(new URL('../fixtures/mcp-approval-server.mjs', import.meta.url));

/** What the fixture server needs to read its scripted decision out of the environment. */
const FIXTURE_ENV_ALLOW = ['XFORGE_TEST_MCP_EXPECTED_VALUE', 'XFORGE_TEST_MCP_DECISION', 'XFORGE_TEST_MCP_APPROVER_ID', 'XFORGE_TEST_MCP_APPROVER_ROLE'];

async function toDesignWithMcpProvider(root: string, env: { allow?: string[]; allowPrefixes?: string[] } = { allow: FIXTURE_ENV_ALLOW }): Promise<void> {
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
    `  command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(fixtureServer)}]`,
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

const mcpApproveArgs = ['approve', '--change', 'add-feature', '--for', 'apply', '--policy', 'planning-solid', '--provider', 'review-bot'];

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
    expect(pending.command).toEqual(['xforge', 'approve', '--change', 'add-feature', '--for', 'apply', '--policy', 'planning-solid', '--provider', 'review-bot']);
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
