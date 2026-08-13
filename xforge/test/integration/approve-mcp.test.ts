import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

const fixtureServer = fileURLToPath(new URL('../fixtures/mcp-approval-server.mjs', import.meta.url));

async function toDesignWithMcpProvider(root: string): Promise<void> {
  await createCompleteSolidChange(root);
  expect((await runCli(root, ['install'])).code).toBe(0);
  expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
  expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);

  await write(root, 'xforge/scaffold/mcp-servers/review-bot.yaml', [
    'apiVersion: xforge.dev/v1alpha2',
    'kind: McpServer',
    'metadata: { name: review-bot, version: 1 }',
    'spec:',
    '  transport: stdio',
    `  command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(fixtureServer)}]`,
    '  authTokenEnv: XFORGE_TEST_MCP_TOKEN',
    '  timeoutSeconds: 10',
    /* The server drives its behavior from these; the stdio subprocess gets only the built-in
       allowlist plus what is declared here, so they must be opted in explicitly. */
    '  env:',
    '    allow: [XFORGE_TEST_MCP_DECISION, XFORGE_TEST_MCP_APPROVER_ID, XFORGE_TEST_MCP_APPROVER_ROLE]',
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
      XFORGE_TEST_MCP_TOKEN: 'shared-secret',
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
      XFORGE_TEST_MCP_TOKEN: 'shared-secret', XFORGE_TEST_MCP_DECISION: 'pending',
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

  it('never passes ambient variables the server manifest does not declare', async () => {
    const root = await fixture();
    await toDesignWithMcpProvider(root);
    /* The fixture server exits immediately if XFORGE_TEST_MCP_FORBIDDEN_LEAK reaches it, which
       surfaces as a connection failure here. The approve succeeds only because the stdio subprocess
       got the built-in allowlist plus the three declared vars — nothing else. */
    const result = await runCli(root, mcpApproveArgs, {
      XFORGE_TEST_MCP_TOKEN: 'shared-secret',
      XFORGE_TEST_MCP_DECISION: 'approve', XFORGE_TEST_MCP_APPROVER_ID: 'alice@example.test', XFORGE_TEST_MCP_APPROVER_ROLE: 'owner',
      XFORGE_TEST_MCP_FORBIDDEN_LEAK: 'ambient-secret-that-must-not-reach-the-server',
    });
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    expect(result.json.data.receipt.approver.id).toBe('alice@example.test');
  });

  it('never passes credential-shaped variables even when the manifest declares them', async () => {
    const root = await fixture();
    await toDesignWithMcpProvider(root);
    await updateYaml(root, 'xforge/scaffold/mcp-servers/review-bot.yaml', (server) => {
      server.spec.env.allow.push('XFORGE_TEST_MCP_AUTH_BACKDOOR');
    });
    /* The deny filter drops credential-shaped names regardless of the allowlist; the fixture server
       exits if the variable reaches it, so an approval that still succeeds proves the drop. */
    const result = await runCli(root, mcpApproveArgs, {
      XFORGE_TEST_MCP_TOKEN: 'shared-secret',
      XFORGE_TEST_MCP_DECISION: 'approve', XFORGE_TEST_MCP_APPROVER_ID: 'alice@example.test', XFORGE_TEST_MCP_APPROVER_ROLE: 'owner',
      XFORGE_TEST_MCP_AUTH_BACKDOOR: 'ambient-auth-shaped-secret',
    });
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    expect(result.json.data.receipt.approver.id).toBe('alice@example.test');
  });
});
