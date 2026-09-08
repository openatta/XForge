import { access, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  advanceSolidToApply, createCompleteSolidChange, fixture, runCli, updateYaml, write, writeVerificationReceipt,
} from '../helpers.js';

/*
 * @red-first coverage-only: this is end-to-end coverage of a Change reaching archive on provider approvals, a path no test walked; the one assertion here that does prove a fix is `stageDeclares.exitConditions` at Verify.
 *
 * The script prints that line, so it is written to stand alone. At length: almost nothing here is
 * repaired behaviour. A governed Change has always been able to close on provider approvals — what
 * did not exist was a test that walked one all the way there, so if the pieces stopped composing
 * nothing would have gone red. This file is mostly that guard.
 *
 * The exception is the exit-condition assertion at Verify, which this walk is what found: `stage`
 * answered `exitConditions: []` for every Stage of every Flow. That one is red against the base,
 * which is why the declaration above is inert in practice — the script only prints it for a file
 * that passes unchanged.
 *
 * A full walk to archive with MCP approvals.
 *
 * `approve-mcp.test.ts` covers the mechanism — submit/poll, pending, malformed bodies, the
 * subprocess env allowlist — and stops at one transition with an unsigned receipt on disk. It never
 * asks whether a Change whose approvals all came from a provider can actually close: both of Solid's
 * approval gates satisfied externally, the delta Spec merged into the canonical tree, the Change
 * moved under `changes/archive/`, and the audit chain still verifying afterwards. Each of those is
 * checked somewhere for the *local* approval path; none of them was checked for this one, and the
 * two paths write different receipts.
 *
 * It is also the composition test for the refactor that moved `stage`, `advance`, argument parsing
 * and the duplicated Flow queries into their own modules. Those are per-Stage surfaces, so a unit
 * test can only ask whether each answers correctly once. A walk asks whether they still agree with
 * each other across six Stages, which is the property the split could break: `stage` reads the Flow
 * through `flow-query`, `advance` runs `check` and `transition` back to back, and `--field` narrows
 * whatever those return. They are exercised here at the Stages where they are actually used rather
 * than in a fixture built to suit them.
 */

const CHANGE = 'add-feature';
const CHANGE_PATH = `xforge/changes/${CHANGE}`;
const fixtureServer = fileURLToPath(new URL('../fixtures/mcp-approval-server.mjs', import.meta.url));

/** What the fixture server reads its scripted decision out of; see fixtures/mcp-approval-server.mjs. */
const FIXTURE_ENV_ALLOW = ['XFORGE_TEST_MCP_EXPECTED_VALUE', 'XFORGE_TEST_MCP_DECISION', 'XFORGE_TEST_MCP_APPROVER_ID', 'XFORGE_TEST_MCP_APPROVER_ROLE'];

/** The approver the mock answers as. `owner` is in both policies' `roles`, so both are satisfiable. */
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
 * Registers the mock as an approval provider on *both* of Solid's policies.
 *
 * `approve-mcp.test.ts` adds it to `planning-solid` only, which is all its one transition needs.
 * A Change cannot close on provider approvals alone unless `closing-solid` names it too, and a
 * policy that does not list the provider refuses the receipt rather than ignoring it — so the
 * second push is what makes this walk possible at all.
 *
 * Registration happens after `install` and before any Gate runs, because it rewrites
 * `xforge/flows/solid.yaml`: the Flow is an input to `policySnapshotDigest` and therefore to
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
  await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
    for (const id of ['planning-solid', 'closing-solid']) {
      flow.governance.approvalPolicies.find((item: any) => item.id === id).providers.push('review-bot');
    }
  });
}

/**
 * `--for` names the transition the approval unlocks, not the Stage it is collected at:
 * `planning-solid` gates `check -> apply` and is requested with `--for apply`; `closing-solid` gates
 * the terminal move and is requested with `--for archive` from `ready-to-archive`.
 */
async function mcpApprove(root: string, transition: string, policy: string, decision: 'approve' | 'pending' = 'approve'): Promise<any> {
  return runCli(root, ['approve', '--change', CHANGE, '--for', transition, '--policy', policy, '--provider', 'review-bot'], mcpEnv(decision));
}

/** Every receipt this policy has on disk, parsed. */
async function receipts(root: string, policy: string): Promise<any[]> {
  const directory = path.join(root, ...CHANGE_PATH.split('/'), 'approvals', policy);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
}

describe('solid lifecycle with MCP approvals', () => {
  it('carries a Change from propose to archive with both approvals granted by the provider', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    /* Removed so the Design Stage genuinely owes an Artifact. `stage` reports the ready Action from
       the Stage's own `produces`, and a fixture that pre-writes everything would report none — the
       one thing this command exists to answer would go unasserted. */
    await rm(path.join(root, ...CHANGE_PATH.split('/'), 'design.md'));
    ok(await runCli(root, ['install']), 'install');
    await registerMcpProvider(root);

    /* Propose. `stage` answers what the Stage is, so the Flow file never has to be opened. */
    const propose = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at propose').data;
    expect(propose.stage).toBe('propose');
    /* `exitConditions` is deliberately not asserted here: Propose declares none, so `[]` would pass
       whether the command computed it or not. It is asserted at Verify, where the Stage has one. */
    expect(propose.stageDeclares).toMatchObject({ produces: ['proposal', 'delta-specs'], gates: ['structure'], authority: 'planning-write' });

    /* Propose -> design through `advance`: the Gates and the Transition in one call, with the
       Evidence and the receipt still written separately. Both halves are asserted below. */
    const advanced = ok(await runCli(root, ['advance', '--change', CHANGE, '--to', 'design']), 'advance to design');
    expect(advanced.data.gates.map((gate: any) => gate.id)).toContain('structure');
    expect(advanced.data.gates.every((gate: any) => gate.status === 'passed')).toBe(true);
    expect(advanced.data.transitioned).toBe('design');
    expect(advanced.changes.some((change: any) => change.path?.includes('transitions/'))).toBe(true);

    /* Design owes an Artifact, so this is where the ready Action is real. */
    const design = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at design').data;
    expect(design.stage).toBe('design');
    expect(design.stageDeclares).toMatchObject({ produces: ['design', 'contract-delta'], reworkTo: ['propose'] });
    expect(design.action).toMatchObject({ action: 'create-artifact', type: 'artifact', id: 'design', status: 'ready' });
    expect(design.action.writes).toEqual([`${CHANGE_PATH}/design.md`]);

    await write(root, `${CHANGE_PATH}/design.md`, '## Decisions\nUse a deterministic fixture.\n');
    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'check']), 'transition to check');
    ok(await runCli(root, ['check', '--change', CHANGE]), 'check at check');

    /* The planning approval, from the provider. */
    const planning = ok(await mcpApprove(root, 'apply', 'planning-solid'), 'mcp approve planning-solid');
    expect(planning.data.status).toBe('recorded');
    expect(planning.data.receipt.approver).toEqual(MCP_APPROVER);

    /*
     * Two `--field` paths in one call. With more than one the reply is an object keyed by the path
     * as written rather than by its leaf, so a caller matching on what it asked for cannot mistake
     * one value for the other — and nothing else is printed, which is what makes it substitutable.
     */
    const fields = await runCli(root, ['state', '--change', CHANGE, '--field', 'change.governance.currentStage', '--field', 'change.governance.revision.contentRevision']);
    expect(fields.code).toBe(0);
    expect(fields.json['change.governance.currentStage']).toBe('check');
    expect(fields.json['change.governance.revision.contentRevision']).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(fields.json)).toHaveLength(2);
    /* The receipt just written is bound to that same revision, which is what makes it count. */
    expect(planning.data.receipt.contentRevision).toBe(fields.json['change.governance.revision.contentRevision']);

    /*
     * Check -> apply through `advance` as well, and `--to` is required rather than optional here:
     * Check declares `reworkTo: [propose, design]`, so more than one Transition is available and
     * choosing between a forward move and a rework route is not a default anything should pick.
     */
    const applied = ok(await runCli(root, ['advance', '--change', CHANGE, '--to', 'apply']), 'advance to apply');
    expect(applied.data.transitioned).toBe('apply');

    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']), 'transition to verify');
    ok(await runCli(root, ['check', '--change', CHANGE]), 'check at verify');
    await writeVerificationReceipt(root, CHANGE);

    /* Verify is the Stage with an exit condition, so this is where that half of `stageDeclares`
       can be asserted against something. */
    const verify = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at verify').data;
    expect(verify.stage).toBe('verify');
    expect(verify.stageDeclares).toMatchObject({ produces: ['assurance'], gates: ['structure', 'unit-tests'], reworkTo: ['apply'] });

    /*
     * The exit condition, asserted here and again off `state`, because the two used to disagree.
     *
     * `stage` answered `exitConditions: []` for every Stage of every Flow: it read
     * `definition.exit?.conditions` out of the Stage summary `state` builds, and that summary
     * flattens the Stage — `exit.gates` is unioned into `gates`, `exit.conditions` becomes a
     * top-level `exitConditions`, and there is no `exit` member at all. The sibling fields were
     * right only because they are read by their flattened names. The field exists so a reader need
     * not open `xforge/flows/*.yaml`, and it was telling Verify it had no exit condition while
     * `verificationReceipt` was the thing about to refuse its Transition.
     *
     * Both are asserted so the two views cannot drift apart again in silence.
     */
    expect(verify.stageDeclares.exitConditions).toEqual(['verificationReceipt']);
    const flows = await runCli(root, ['state', '--change', CHANGE, '--field', 'flows']);
    expect(flows.code).toBe(0);
    const verifyStage = flows.json.find((flow: any) => flow.id === 'solid').stages.find((stage: any) => stage.id === 'verify');
    expect(verifyStage.exitConditions).toEqual(['verificationReceipt']);

    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'ready-to-archive']), 'transition to ready-to-archive');

    /* The closing approval, from the same provider. */
    const closing = ok(await mcpApprove(root, 'archive', 'closing-solid'), 'mcp approve closing-solid');
    expect(closing.data.status).toBe('recorded');
    expect(closing.data.receipt.approver).toEqual(MCP_APPROVER);

    /*
     * Read back off disk, not out of the two replies above. A local approval leaking into either
     * gate would still leave this Change archivable, and the reply that recorded it is not the
     * thing archive reads — the receipts are. `type: 'external-system'` and the absent signature
     * are the two marks a terminal approval cannot produce.
     */
    for (const policy of ['planning-solid', 'closing-solid']) {
      const written = await receipts(root, policy);
      expect(written, policy).toHaveLength(1);
      expect(written[0].approver, policy).toEqual(MCP_APPROVER);
      expect(written[0].signature, policy).toBeUndefined();
      expect(written[0].policyId, policy).toBe(policy);
    }

    const archived = ok(await runCli(root, ['archive', '--change', CHANGE]), 'archive');
    expect(archived.data.specs).toEqual(['xforge/specs/widget/spec.md']);

    /* The Change is gone from the active path and present under the archive, the delta Spec is in
       the canonical tree, and the chain that recorded all of it still verifies. */
    expect(await exists(path.join(root, ...CHANGE_PATH.split('/')))).toBe(false);
    const archiveNames = await readdir(path.join(root, 'xforge', 'changes', 'archive'));
    expect(archiveNames).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}-add-feature$/)]);
    expect(await readFile(path.join(root, 'xforge', 'specs', 'widget', 'spec.md'), 'utf8')).toContain('### Requirement: Widget works');
    /* The receipts travelled with the Change rather than being left behind or dropped. */
    expect(await exists(path.join(root, 'xforge', 'changes', 'archive', archiveNames[0]!, 'approvals', 'closing-solid'))).toBe(true);

    const audit = ok(await runCli(root, ['audit', 'verify']), 'audit verify');
    expect(audit.data.valid).toBe(true);
  });

  /*
   * The other half of the same claim: the provider decides, so a decision that has not arrived has
   * to hold the Change at the door. `approve-mcp.test.ts` proves a pending poll writes nothing;
   * what it cannot say is that the absence is what archive is reading.
   *
   * The planning approval here is granted locally through the shared helper, deliberately. This
   * test is about `closing-solid`, the primary test above already pins where both receipts come
   * from, and a second full MCP walk would buy nothing in a suite that already runs four minutes.
   */
  it('refuses to archive while the closing approval is still pending at the provider', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    ok(await runCli(root, ['install']), 'install');
    await registerMcpProvider(root);
    await advanceSolidToApply(root);
    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']), 'transition to verify');
    ok(await runCli(root, ['check', '--change', CHANGE]), 'check at verify');
    await writeVerificationReceipt(root, CHANGE);
    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'ready-to-archive']), 'transition to ready-to-archive');

    const pending = ok(await mcpApprove(root, 'archive', 'closing-solid', 'pending'), 'mcp approve pending');
    expect(pending.data).toMatchObject({ status: 'pending', receipt: null, policy: 'closing-solid' });
    expect(pending.changes).toEqual([]);

    const archived = await runCli(root, ['archive', '--change', CHANGE]);
    expect(archived.code).toBe(1);
    const blocked = archived.json.diagnostics.filter((item: any) => item.code === 'XFORGE_ARCHIVE_GOVERNANCE_BLOCKED');
    /* Named down to the policy and the count: one approval short on `closing-solid`, which is the
       one the provider has not decided yet. Anything else refusing would satisfy `code === 1`. */
    expect(blocked.map((item: any) => item.message)).toContain('Archive governance is blocked by approval:closing-solid:missing-1.');
    expect(await exists(path.join(root, ...CHANGE_PATH.split('/'), 'change.yaml'))).toBe(true);
  });
});
