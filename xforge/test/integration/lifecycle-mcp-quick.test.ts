import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { changeYaml, fixture, runCli, updateYaml, write, writeVerificationReceipt } from '../helpers.js';

/*
 * @red-first coverage-only: the shipped `quick` Flow walked to archive on its one provider approval — behaviour that already works and that no test had walked end to end, so there is no fix here for a red run to prove.
 *
 * `lifecycle-mcp-e2e.test.ts` makes the same claim for `solid` and states the general case: a
 * Change closing on provider approvals alone was never walked, and the local and MCP paths write
 * different receipts. This file is the other Flow, and it is here for what is *different* about it.
 *
 * Solid has two approval policies and six Stages, so a walk through it can be satisfied by the
 * governance being redundant — miss one gate and the other still stops the Change. Quick has one
 * of everything: three Stages, no design, no check, no planning approval, and a single
 * `quick-close` policy at the terminal move. That policy is the entire governance surface of the
 * Flow whose whole premise is that a low-risk Change goes from a proposal straight to
 * implementation. If it can be satisfied by something other than the provider that decided it, or
 * skipped because there is no second policy behind it, nothing else on this Flow would notice.
 *
 * The refactored per-Stage surfaces are exercised where Quick makes them answer something Solid
 * cannot ask. `advance` runs at Apply, a Stage that declares no Gates at all: the composition has
 * to hold when the `check` half has nothing to run, rather than always arriving with fresh
 * Evidence behind it. And `stage` is asked at Apply what a Stage produces when the answer is
 * nothing — the case where a Stage-scoped reply has to say "no Artifact" without being wrong.
 */

const CHANGE = 'fast-fix';
const CHANGE_PATH = `xforge/changes/${CHANGE}`;
const fixtureServer = fileURLToPath(new URL('../fixtures/mcp-approval-server.mjs', import.meta.url));

/** What the fixture server reads its scripted decision out of; see fixtures/mcp-approval-server.mjs. */
const FIXTURE_ENV_ALLOW = ['XFORGE_TEST_MCP_EXPECTED_VALUE', 'XFORGE_TEST_MCP_DECISION', 'XFORGE_TEST_MCP_APPROVER_ID', 'XFORGE_TEST_MCP_APPROVER_ROLE'];

/** `owner` is in `quick-close`'s `roles`, which is the only policy on this Flow. */
const MCP_APPROVER = { id: 'release-bot@example.test', provider: 'review-bot', role: 'owner', type: 'external-system' };

const mcpEnv = (decision: 'approve' | 'reject' | 'pending'): NodeJS.ProcessEnv => ({
  XFORGE_TEST_MCP_TOKEN: 'shared-secret',
  XFORGE_TEST_MCP_EXPECTED_VALUE: 'shared-secret',
  XFORGE_TEST_MCP_DECISION: decision,
  XFORGE_TEST_MCP_APPROVER_ID: MCP_APPROVER.id,
  XFORGE_TEST_MCP_APPROVER_ROLE: MCP_APPROVER.role,
});

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

function ok(result: Awaited<ReturnType<typeof runCli>>, what: string): any {
  expect(result.code, `${what}: ${JSON.stringify(result.json?.diagnostics ?? result.stderr, null, 2)}`).toBe(0);
  return result.json;
}

/**
 * The Change as Quick's Propose Stage owes it: the proposal and the delta Spec, and nothing else.
 *
 * `assurance` is deliberately absent. It belongs to Verify, and writing it here would leave the
 * one Stage that produces an Artifact with nothing to produce — so `stage` at Verify would report
 * no ready Action, and the assertion that it names one would pass without meaning anything.
 *
 * `changeYaml('quick')` classifies `risk: low` with a single module, which is exactly what Quick's
 * `eligibleWhen` admits; raising either would move the Change to another Flow before it started.
 */
async function createQuickChange(root: string): Promise<void> {
  await write(root, `${CHANGE_PATH}/change.yaml`, changeYaml('quick'));
  await write(root, `${CHANGE_PATH}/proposal.md`, '## Why\nTest\n\n## Flow choice\nquick\n');
  await write(root, `${CHANGE_PATH}/specs/widget/spec.md`, '## ADDED Requirements\n\n### Requirement: Widget works\n\n#### Scenario: success\n- **WHEN** used\n- **THEN** it works\n');
}

/**
 * Registers the mock on `quick-close`, the Flow's only policy.
 *
 * Quick ships it as `providers: [local, enterprise-approvals]`, and a policy that does not name the
 * provider refuses the receipt rather than ignoring it — so without this push there is no route to
 * archive that is not the local terminal.
 *
 * Registration happens after `install` and before any Gate runs, because it rewrites
 * `xforge/flows/quick.yaml`: the Flow is an input to `policySnapshotDigest` and therefore to
 * `contentRevision`, so Evidence produced before this edit would be stale the moment it landed.
 */
async function registerMcpProvider(root: string): Promise<void> {
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
    `    allow: ${JSON.stringify(FIXTURE_ENV_ALLOW)}`,
    '',
  ].join('\n'));
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
    /* Appended, never assigned: replacing the list deselects the shipped `enterprise-approvals`
       server while `approvals.providers` still names it, which `check` reports as dangling. */
    manifest.scaffold.mcpServers.push('review-bot');
    manifest.approvals.providers.push({ id: 'review-bot', type: 'mcp', mcpServer: 'review-bot', roles: ['owner', 'maintainer'] });
  });
  await updateYaml(root, 'xforge/flows/quick.yaml', (flow) => {
    flow.governance.approvalPolicies.find((item: any) => item.id === 'quick-close').providers.push('review-bot');
  });
}

/** `--for archive`: the transition the approval unlocks, not the Stage it is collected at. */
async function mcpApprove(root: string, decision: 'approve' | 'pending' = 'approve'): Promise<any> {
  return runCli(root, ['approve', '--change', CHANGE, '--for', 'archive', '--policy', 'quick-close', '--provider', 'review-bot'], mcpEnv(decision));
}

/** Every receipt `quick-close` has on disk, parsed. */
async function quickCloseReceipts(root: string): Promise<any[]> {
  const directory = path.join(root, ...CHANGE_PATH.split('/'), 'approvals', 'quick-close');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
}

describe('quick lifecycle with an MCP approval', () => {
  it('carries a Change from propose to archive with its one approval granted by the provider', async () => {
    const root = await fixture();
    await createQuickChange(root);
    ok(await runCli(root, ['install']), 'install');
    await registerMcpProvider(root);

    /* Propose. `stage` answers what the Stage is, so the Flow file never has to be opened.
       `exitConditions` is not asserted here — Propose declares none, so `[]` would pass whether the
       command computed it or not. It is asserted at Verify, the one Stage on this Flow that has one. */
    const propose = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at propose').data;
    expect(propose.flow).toBe('quick');
    expect(propose.stage).toBe('propose');
    expect(propose.stageDeclares).toMatchObject({ produces: ['proposal', 'delta-specs'], gates: ['structure'], authority: 'planning-write' });

    /* Propose -> apply through `advance`: the Gate and the Transition in one call, with the
       Evidence and the receipt still written separately. Both halves are asserted below. */
    const toApply = ok(await runCli(root, ['advance', '--change', CHANGE, '--to', 'apply']), 'advance to apply');
    expect(toApply.data.gates.map((gate: any) => gate.id)).toEqual(['structure']);
    expect(toApply.data.gates.every((gate: any) => gate.status === 'passed')).toBe(true);
    expect(toApply.data.transitioned).toBe('apply');
    expect(toApply.changes.some((change: any) => change.path?.includes('transitions/'))).toBe(true);

    /*
     * Apply produces nothing, which is the Stage-scoped answer Solid's walk never asks for: every
     * Stage it visits owes an Artifact, so a reply that leaked a neighbouring Stage's Artifact into
     * `owes` would look right there. Here the correct answer is the empty one.
     */
    const apply = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at apply').data;
    expect(apply.stage).toBe('apply');
    expect(apply.stageDeclares).toMatchObject({ produces: [], gates: [], reworkTo: ['propose'], authority: 'implementation-write' });
    expect(apply.owes).toEqual([]);

    /*
     * Apply -> verify through `advance` as well, and this is the call Quick is here to make: Apply
     * declares no Gates, so `advance` runs its `check` half over an empty Gate set and must still
     * move the Change. A composition that treated "no Gate Evidence produced" as "nothing passed"
     * would refuse exactly here, on the Flow with no Gate between propose and verify.
     */
    const toVerify = ok(await runCli(root, ['advance', '--change', CHANGE, '--to', 'verify']), 'advance to verify');
    expect(toVerify.data.gates).toEqual([]);
    expect(toVerify.data.transitioned).toBe('verify');

    /* Verify owes the assurance, so this is where the ready Action is real. */
    const verify = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at verify').data;
    expect(verify.stage).toBe('verify');
    expect(verify.stageDeclares).toMatchObject({ produces: ['assurance'], gates: ['structure', 'unit-tests'], reworkTo: ['apply'] });
    expect(verify.action).toMatchObject({ action: 'create-artifact', type: 'artifact', id: 'assurance', status: 'ready' });
    expect(verify.action.writes).toEqual([`${CHANGE_PATH}/assurance.md`]);
    /* Verify is the only Stage on this Flow with an exit condition, so it is the only place the
       other half of `stageDeclares` can be asserted against something. */
    expect(verify.stageDeclares.exitConditions).toEqual(['verificationReceipt']);

    await write(root, `${CHANGE_PATH}/assurance.md`, '## Completeness\nAll requirements are covered.\n');
    /* `check` after the Artifact, not before: Gate Evidence binds to the content revision, and
       Evidence taken before this write would be stale by the time the receipt cited it. */
    ok(await runCli(root, ['check', '--change', CHANGE]), 'check at verify');
    await writeVerificationReceipt(root, CHANGE);
    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'ready-to-archive']), 'transition to ready-to-archive');

    /*
     * Two `--field` paths in one call. With more than one the reply is an object keyed by the path
     * as written rather than by its leaf, and nothing else is printed — which is what makes it
     * substitutable for reading the whole state.
     */
    const fields = await runCli(root, ['state', '--change', CHANGE, '--field', 'change.governance.currentStage', '--field', 'change.governance.revision.contentRevision']);
    expect(fields.code).toBe(0);
    expect(fields.json['change.governance.currentStage']).toBe('ready-to-archive');
    expect(fields.json['change.governance.revision.contentRevision']).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(fields.json)).toHaveLength(2);

    /* The one approval this Flow has, from the provider. */
    const closing = ok(await mcpApprove(root), 'mcp approve quick-close');
    expect(closing.data.status).toBe('recorded');
    expect(closing.data.receipt.approver).toEqual(MCP_APPROVER);
    /* Bound to the revision the Change is actually at, which is what makes it count. */
    expect(closing.data.receipt.contentRevision).toBe(fields.json['change.governance.revision.contentRevision']);

    /*
     * Read back off disk, not out of the reply above. A local approval leaking in would still leave
     * this Change archivable, and the reply that recorded it is not the thing archive reads — the
     * receipt is. `type: 'external-system'` and the absent signature are the two marks a terminal
     * approval cannot produce.
     */
    const written = await quickCloseReceipts(root);
    expect(written).toHaveLength(1);
    expect(written[0].approver).toEqual(MCP_APPROVER);
    expect(written[0].signature).toBeUndefined();
    expect(written[0].policyId).toBe('quick-close');
    /* And it is the only policy with anything on disk: on Quick there is no second approval a
       mistake could hide behind. */
    expect(await readdir(path.join(root, ...CHANGE_PATH.split('/'), 'approvals'))).toEqual(['quick-close']);

    const archived = ok(await runCli(root, ['archive', '--change', CHANGE]), 'archive');
    expect(archived.data.specs).toEqual(['xforge/specs/widget/spec.md']);

    /* The Change is gone from the active path and present under the archive, the delta Spec is in
       the canonical tree, and the chain that recorded all of it still verifies. */
    expect(await exists(path.join(root, ...CHANGE_PATH.split('/')))).toBe(false);
    const archiveNames = await readdir(path.join(root, 'xforge', 'changes', 'archive'));
    expect(archiveNames).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}-fast-fix$/)]);
    expect(await readFile(path.join(root, 'xforge', 'specs', 'widget', 'spec.md'), 'utf8')).toContain('### Requirement: Widget works');
    /* The receipt travelled with the Change rather than being left behind or dropped. */
    expect(await exists(path.join(root, 'xforge', 'changes', 'archive', archiveNames[0]!, 'approvals', 'quick-close'))).toBe(true);

    const audit = ok(await runCli(root, ['audit', 'verify']), 'audit verify');
    expect(audit.data.valid).toBe(true);
  });

  /*
   * The other half of the same claim: the provider decides, so a decision that has not arrived has
   * to hold the Change at the door — and on Quick that door is the only one there is.
   */
  it('refuses to archive while the one approval is still pending at the provider', async () => {
    const root = await fixture();
    await createQuickChange(root);
    ok(await runCli(root, ['install']), 'install');
    await registerMcpProvider(root);

    ok(await runCli(root, ['advance', '--change', CHANGE, '--to', 'apply']), 'advance to apply');
    ok(await runCli(root, ['advance', '--change', CHANGE, '--to', 'verify']), 'advance to verify');
    await write(root, `${CHANGE_PATH}/assurance.md`, '## Completeness\nAll requirements are covered.\n');
    ok(await runCli(root, ['check', '--change', CHANGE]), 'check at verify');
    await writeVerificationReceipt(root, CHANGE);
    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'ready-to-archive']), 'transition to ready-to-archive');

    const pending = ok(await mcpApprove(root, 'pending'), 'mcp approve pending');
    expect(pending.data).toMatchObject({ status: 'pending', receipt: null, policy: 'quick-close' });
    expect(pending.changes).toEqual([]);

    const archived = await runCli(root, ['archive', '--change', CHANGE]);
    expect(archived.code).toBe(1);
    const blocked = archived.json.diagnostics.filter((item: any) => item.code === 'XFORGE_ARCHIVE_GOVERNANCE_BLOCKED');
    /* Named down to the policy and the count, because `code === 1` would be satisfied by anything
       refusing — including the audit policy, which requires an `approval.decided` event that a
       pending poll also fails to produce. */
    expect(blocked.map((item: any) => item.message)).toContain('Archive governance is blocked by approval:quick-close:missing-1.');
    expect(await exists(path.join(root, ...CHANGE_PATH.split('/'), 'change.yaml'))).toBe(true);
  });
});
