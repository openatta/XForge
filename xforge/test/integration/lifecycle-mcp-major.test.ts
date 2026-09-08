import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  changeYaml, checkFindings, constitutionLedger, fixture, runCli, updateYaml, write, writeVerificationReceipt,
} from '../helpers.js';

/*
 * @red-first coverage-only: nothing here is a fix; it is the first walk of the Major Flow to archive, a path no test reaches, so there is no earlier revision it could fail against.
 *
 * Major is the Flow with the governance nobody had walked. `lifecycle-mcp-e2e.test.ts` does this
 * for Solid, and Solid's exits are Gates and approvals — things a Stage runs. Major adds the three
 * exits that are *decided from ledgers a human is supposed to have filled in*: `materialQuestions`
 * at Clarify, `contractDecisions` at Check, `independentReview` at Verify. Each is satisfied by a
 * different mechanism, none of them a Gate, and two of them turn on identity rather than content.
 * They are also the exits with no test standing behind their composition: a Change that satisfies
 * one of them in isolation is covered; a Change that has to satisfy all three, in order, across six
 * Stages of Gates and two provider approvals, was not.
 *
 * What this file therefore guards, beyond "Major can close":
 *
 *  - The empty-identity path in `core/ledger-identity.ts` is reachable and is what lets a Change
 *    with no commits and no receipts write its first condition ledger. Clarify comes before any
 *    approval, so `decidedBy` has nothing to be checked against; the ledger is accepted, and the
 *    name chosen here is the one that stays valid afterwards.
 *  - `contractDecisions` is *not* owed by a Change that declares no `moduleContract` impact, and
 *    neither is the `contract-delta` Artifact. Both are narrowed by the same `requiredWhen`, and a
 *    walk is the only thing that proves the narrowing agrees between the exit condition and the
 *    Artifact — they are evaluated by different code.
 *  - `independentReview` under the plan-less delivery shape needs a Change-level review receipt,
 *    which only `xforge review acknowledge` can mint: the receipt is worthless unless the audit
 *    chain attests it, so this is the one exit condition a test cannot fake by writing a file.
 *
 * Both approvals come from the provider, as in the Solid walk and for the same reason: a Change
 * that closes on receipts a terminal could not have produced is the only version of this claim
 * worth asserting. Major's policies are `separationOfDuties: true`, which the Solid walk does not
 * exercise — it holds here because `changeImplementers` reads Git authors of the Change directory
 * and the fixture is not a repository, so the implementer set is empty and the mock's approver
 * cannot be in it. That is asserted rather than assumed.
 */

const CHANGE = 'harden-widget';
const CHANGE_PATH = `xforge/changes/${CHANGE}`;
const fixtureServer = fileURLToPath(new URL('../fixtures/mcp-approval-server.mjs', import.meta.url));

/** What the fixture server reads its scripted decision out of; see fixtures/mcp-approval-server.mjs. */
const FIXTURE_ENV_ALLOW = ['XFORGE_TEST_MCP_EXPECTED_VALUE', 'XFORGE_TEST_MCP_DECISION', 'XFORGE_TEST_MCP_APPROVER_ID', 'XFORGE_TEST_MCP_APPROVER_ROLE'];

/** `owner` is in both Major policies' `roles`, so one approver satisfies both. */
const MCP_APPROVER = { id: 'release-bot@example.test', provider: 'review-bot', role: 'owner', type: 'external-system' };

const mcpEnv = (): NodeJS.ProcessEnv => ({
  XFORGE_TEST_MCP_TOKEN: 'shared-secret',
  XFORGE_TEST_MCP_EXPECTED_VALUE: 'shared-secret',
  XFORGE_TEST_MCP_DECISION: 'approve',
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

/** Registers the mock on both Major policies, before any Gate runs — see the Solid walk's note. */
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
    manifest.scaffold.mcpServers.push('review-bot');
    manifest.approvals.providers.push({ id: 'review-bot', type: 'mcp', mcpServer: 'review-bot', roles: ['owner', 'maintainer'] });
  });
  await updateYaml(root, 'xforge/flows/major.yaml', (flow) => {
    for (const id of ['implementation-major', 'closing-major']) {
      flow.governance.approvalPolicies.find((item: any) => item.id === id).providers.push('review-bot');
    }
  });
}

async function mcpApprove(root: string, transition: string, policy: string): Promise<any> {
  return runCli(root, ['approve', '--change', CHANGE, '--for', transition, '--policy', policy, '--provider', 'review-bot'], mcpEnv());
}

/** Every receipt this policy has on disk, parsed. */
async function receipts(root: string, policy: string): Promise<any[]> {
  const directory = path.join(root, ...CHANGE_PATH.split('/'), 'approvals', policy);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
}

/**
 * Every Artifact Major owes, except `design.md`, written before the first Gate runs.
 *
 * `contract-delta` is deliberately absent and is not an omission: it is `requiredWhen.anyImpact:
 * [moduleContract]`, `changeYaml` declares no such impact, and the walk asserts that the Stage that
 * produces it reports it as not owed rather than blocking on an empty glob.
 *
 * Everything else is written up front so that the content revision stops moving once Design is
 * written, which is what lets Check's Gate Evidence still be bound at Verify. `design.md` is left
 * out for the reason the Solid walk leaves it out: a Stage that owes nothing reports no ready
 * Action, and `stage`'s whole job would go unasserted.
 */
async function createMajorChange(root: string): Promise<void> {
  await write(root, `${CHANGE_PATH}/change.yaml`, changeYaml('major'));
  await write(root, `${CHANGE_PATH}/proposal.md`, [
    '## Why', 'The widget accepts unbounded input.', '',
    '## Scope', 'The widget input path.', '',
    '## Non-goals', 'No storage format change.', '',
    '## Actors and success criteria', 'Operators; oversized input is refused.', '',
    '## Flow choice', 'major: the classification is high risk.', '',
    '## Critical impacts and rollback', 'Revert the bound; no data migration.', '',
  ].join('\n'));
  await write(root, `${CHANGE_PATH}/specs/widget/spec.md`, '## ADDED Requirements\n\n### Requirement: Widget bounds input\n\n#### Scenario: oversized input\n- **WHEN** input exceeds the bound\n- **THEN** it is refused\n');
  await write(root, `${CHANGE_PATH}/clarifications.md`, [
    '## Material questions', 'Whether the bound is configurable.', '',
    '## Decisions', 'Fixed bound for this Change.', '',
    '## Sources', 'proposal.md', '',
    '## Resolved updates', 'Proposal scope narrowed to a fixed bound.', '',
  ].join('\n'));
  /*
   * The ledger Clarify actually exits on; `clarifications.md` above is prose the condition ignores.
   *
   * `decidedBy` names the mock approver, which at Clarify is a name nothing can check: no receipt
   * exists yet, the fixture is not a Git repository, so `knownIdentities` is empty and
   * `unknownIdentityReason` takes its documented permissive branch. Naming the approver rather than
   * an invented person is what keeps the entry valid after the first receipt lands and the set stops
   * being empty — the trap `core/ledger-identity.ts` describes, met here in the direction that
   * passes rather than the one that surprises.
   */
  await write(root, `${CHANGE_PATH}/evidence/conditions/materialQuestions.yaml`, [
    'condition: materialQuestions',
    'entries:',
    '  - id: Q1',
    '    question: Is the input bound configurable per deployment?',
    '    impact: scope',
    '    decision: No; a fixed bound ships with this Change.',
    `    decidedBy: ${MCP_APPROVER.id}`,
    '    decidedAt: 2026-01-02T00:00:00Z',
    '',
  ].join('\n'));
  await write(root, `${CHANGE_PATH}/check-report.md`, [
    '## Completeness', 'Every Requirement has a scenario.', '',
    '## Consistency', 'Proposal, Specs and design agree.', '',
    '## Testability', 'The bound is observable at the input path.', '',
    '## Feasibility and risk', 'Low; the change is local.', '',
    '## Gates and evidence', 'structure, check-findings and constitution-check passed.', '',
    '## Rework', 'Nothing to rework.', '',
  ].join('\n'));
  await write(root, `${CHANGE_PATH}/evidence/check-findings.yaml`, checkFindings());
  await write(root, `${CHANGE_PATH}/evidence/constitution-check.yaml`, await constitutionLedger(root));
  await write(root, `${CHANGE_PATH}/assurance.md`, [
    '## Completeness', 'All requirements are covered.', '',
    '## Correctness', 'The bound refuses oversized input.', '',
    '## Coherence', 'Design and delta Specs agree.', '',
    '## Risk controls', 'Rollback is a one-line revert.', '',
    '## Gates and evidence', 'structure, unit-tests and security-scan passed at Verify.', '',
    '## Findings', 'None.', '',
  ].join('\n'));
}

describe('major lifecycle with MCP approvals', () => {
  it('carries a high-risk Change from propose to archive with both approvals granted by the provider', async () => {
    const root = await fixture();
    await createMajorChange(root);
    ok(await runCli(root, ['install']), 'install');
    await registerMcpProvider(root);

    /* Propose. Six Stages, and `stage` is what says so without opening the Flow file. */
    const propose = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at propose').data;
    expect(propose.stage).toBe('propose');
    expect(propose.stageDeclares).toMatchObject({ produces: ['proposal', 'delta-specs'], gates: ['structure'], authority: 'planning-write', exitConditions: [] });

    /* Propose -> clarify through `advance`: the Stage's Gates and the Transition in one call. */
    const advanced = ok(await runCli(root, ['advance', '--change', CHANGE, '--to', 'clarify']), 'advance to clarify');
    expect(advanced.data.gates.map((gate: any) => gate.id)).toContain('structure');
    expect(advanced.data.gates.every((gate: any) => gate.status === 'passed')).toBe(true);
    expect(advanced.data.transitioned).toBe('clarify');

    /*
     * Clarify is the Stage whose only blocker is a condition: no Gates, no approvals, and an exit
     * decided entirely by `evidence/conditions/materialQuestions.yaml`. That makes it the one place
     * `stageDeclares.exitConditions` can be read against a Stage where it is the whole story.
     */
    const clarify = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at clarify').data;
    expect(clarify.stage).toBe('clarify');
    expect(clarify.stageDeclares).toMatchObject({ produces: ['clarifications', 'material-questions'], gates: [], reworkTo: ['propose'] });
    expect(clarify.stageDeclares.exitConditions).toEqual(['materialQuestions']);

    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']), 'transition to design');

    /*
     * Design owes `design` and, on paper, `contract-delta`. The ready Action is `design`: the
     * second Artifact is narrowed by `requiredWhen.anyImpact: [moduleContract]` and this Change
     * declares no such impact, so it is reported `not-owed` rather than holding the Stage open on a
     * glob that will never match. That narrowing is the Artifact half of the same predicate the
     * Check exit reads for `contractDecisions`, asserted below.
     */
    const design = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at design').data;
    expect(design.stage).toBe('design');
    expect(design.stageDeclares).toMatchObject({ produces: ['design', 'contract-delta'], reworkTo: ['propose', 'clarify'] });
    expect(design.action).toMatchObject({ action: 'create-artifact', type: 'artifact', id: 'design', status: 'ready' });
    expect(design.owes.map((artifact: any) => artifact.id)).toEqual(['design']);
    /* And absent from `state` entirely, which is how a `not-owed` Artifact is reported: the payload
       drops them, so `owes` and the Artifact list agree that nothing here is waiting on a contract
       delta. Both are read, because `stage` computes `owes` itself rather than from this list. */
    const artifacts = ok(await runCli(root, ['state', '--change', CHANGE]), 'state at design').data.change.artifacts;
    expect(artifacts.map((artifact: any) => artifact.id)).not.toContain('contract-delta');

    await write(root, `${CHANGE_PATH}/design.md`, [
      '## Context and constraints', 'The input path is shared with the legacy reader.', '',
      '## Decisions and alternatives', 'Bound at the parser. **Rejected alternative:** bound at the caller.', '',
      '## Trust boundaries', 'Untrusted input crosses at the parser only.', '',
      '## Risks and mitigations', 'Truncation is observable; the bound is logged.', '',
      '## Test strategy', 'A scenario per Requirement in the delta Specs.', '',
      '## Rollout, monitoring and stop signals', 'Single release; stop on parser error rate.', '',
      '## Owners and parallel boundaries', 'One owner, no parallel packages.', '',
      '## Migration and rollback', 'Revert the bound.', '',
    ].join('\n'));
    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'check']), 'transition to check');

    /*
     * Check runs three Gates rather than Solid's one, and `constitution-check` is the one that turns
     * on the same identity rule the Clarify ledger did. It passes provisionally here — with nothing
     * to check the names against — which is exactly what `unverifiableIdentityWarning` exists to
     * disclose, and why the ledgers above name the approver instead of a person nobody records.
     */
    const check = ok(await runCli(root, ['check', '--change', CHANGE]), 'check at check');
    expect(check.data.gates.map((gate: any) => gate.id).sort()).toEqual(['check-findings', 'constitution-check', 'structure']);
    expect(check.data.gates.every((gate: any) => gate.status === 'passed')).toBe(true);

    /*
     * `separationOfDuties: true` on both Major policies, and the one thing that could make it
     * unsatisfiable is said out loud before it is satisfied.
     *
     * The implementer set is the Git authors of the Change directory (`core/revision.ts`'s
     * `changeImplementers`); the fixture is not a repository, so the set is empty and no approver
     * can be in it. The proof is in which token blocks: `missing-1` and not
     * `separation-of-duties`, which is the block a policy raises when its only approver is also an
     * implementer. If the fixture ever gained a `git init` this is the assertion that would
     * explain why both approvals started failing.
     */
    const beforeApproval = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at check').data;
    expect(beforeApproval.blockedBy).toContain('approval:implementation-major:missing-1');
    expect(beforeApproval.blockedBy).not.toContain('approval:implementation-major:separation-of-duties');
    /*
     * `contractDecisions` is the exit-condition half of the `moduleContract` narrowing asserted at
     * Design, and the two halves report it differently — deliberately, and worth pinning.
     *
     * `stageDeclares` says what the Stage declares, so the key is listed whether or not this
     * Change is owed it; the Artifact list drops `contract-delta` outright because `not-owed` is a
     * status an Artifact can hold and a declaration cannot. What decides is `blockedBy`: the
     * condition is narrowed by `requiredWhen.anyImpact: [moduleContract]`, `changeYaml` declares no
     * such impact, so `exitConditionExpectation` returns null and no ledger is ever asked for. A
     * reader taking `exitConditions` for a to-do list would go and write a ledger nothing reads,
     * which is why both are asserted here rather than one.
     */
    expect(beforeApproval.stageDeclares.exitConditions).toEqual(['contractDecisions']);
    expect(beforeApproval.blockedBy.join(' ')).not.toContain('contractDecisions');

    /* The implementation approval, from the provider. */
    const implementation = ok(await mcpApprove(root, 'apply', 'implementation-major'), 'mcp approve implementation-major');
    expect(implementation.data.status).toBe('recorded');
    expect(implementation.data.receipt.approver).toEqual(MCP_APPROVER);

    /*
     * Two `--field` paths in one call: the reply is keyed by the path as written, and carries
     * nothing else. The second value is what the receipt just written is bound to, so the pair also
     * says the approval speaks for the content the Gates above ran against.
     */
    const fields = await runCli(root, ['state', '--change', CHANGE, '--field', 'change.governance.currentStage', '--field', 'change.governance.revision.contentRevision']);
    expect(fields.code).toBe(0);
    expect(fields.json['change.governance.currentStage']).toBe('check');
    expect(fields.json['change.governance.revision.contentRevision']).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(fields.json)).toHaveLength(2);
    expect(implementation.data.receipt.contentRevision).toBe(fields.json['change.governance.revision.contentRevision']);

    /* Check -> apply through `advance`; `--to` is required, Check offers three rework routes too. */
    const applied = ok(await runCli(root, ['advance', '--change', CHANGE, '--to', 'apply']), 'advance to apply');
    expect(applied.data.transitioned).toBe('apply');

    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']), 'transition to verify');
    ok(await runCli(root, ['check', '--change', CHANGE]), 'check at verify');
    await writeVerificationReceipt(root, CHANGE);

    /*
     * Verify declares both conditions, and this is where `stageDeclares.exitConditions` has to
     * carry more than one. Order is the Flow's, so it is asserted as a set rather than a list.
     *
     * Asked here, with the verification receipt written and the review not yet recorded, so the
     * two conditions are in different states and the reply distinguishes them. `blockedBy` naming
     * `review-missing` alone is what makes the acknowledgement below a step this walk needs rather
     * than one it happens to perform: without the block, deleting the next four lines would leave
     * the test passing and `independentReview` unexercised.
     */
    const verify = ok(await runCli(root, ['stage', '--change', CHANGE]), 'stage at verify').data;
    expect(verify.stage).toBe('verify');
    expect(verify.stageDeclares).toMatchObject({ produces: ['assurance'], gates: ['structure', 'unit-tests', 'security-scan'], reworkTo: ['apply'] });
    expect([...verify.stageDeclares.exitConditions].sort()).toEqual(['independentReview', 'verificationReceipt']);
    expect(verify.blockedBy).toContain('condition:independentReview:review-missing');
    expect(verify.blockedBy.join(' ')).not.toContain('condition:verificationReceipt');

    /*
     * The condition no test can satisfy by writing a file: a review receipt is only counted when
     * the audit chain attests its digest, so it has to be minted by the command. There is no
     * `--by` — the actor comes from the environment — which is the Flow's own position that
     * independence is reported rather than asserted. The transcript lives under `evidence/review/`,
     * which `contentRevision` does not digest, so recording it does not stale the Gates that just
     * ran.
     */
    await write(root, `${CHANGE_PATH}/evidence/review/change-review.md`, '# Change review\n\nRead the delta Specs, the design and the assurance against the delivered bound. No blockers.\n');
    const review = ok(await runCli(root, ['review', 'acknowledge', '--change', CHANGE, '--evidence', `${CHANGE_PATH}/evidence/review/change-review.md`, '--scope', 'Full review of the delivered work.']), 'review acknowledge');
    expect(review.data.contentRevision).toBe(fields.json['change.governance.revision.contentRevision']);

    /* Which the closing transition then proves cleared. */
    ok(await runCli(root, ['transition', '--change', CHANGE, '--to', 'ready-to-archive']), 'transition to ready-to-archive');

    /* The closing approval, from the same provider. */
    const closing = ok(await mcpApprove(root, 'archive', 'closing-major'), 'mcp approve closing-major');
    expect(closing.data.status).toBe('recorded');
    expect(closing.data.receipt.approver).toEqual(MCP_APPROVER);

    /*
     * Read back off disk rather than out of the replies: a local approval leaking into either gate
     * would leave this Change equally archivable, and the receipts are what archive reads.
     * `type: 'external-system'` and the absent signature are the two marks a terminal cannot make.
     */
    for (const policy of ['implementation-major', 'closing-major']) {
      const written = await receipts(root, policy);
      expect(written, policy).toHaveLength(1);
      expect(written[0].approver, policy).toEqual(MCP_APPROVER);
      expect(written[0].signature, policy).toBeUndefined();
      expect(written[0].policyId, policy).toBe(policy);
    }

    const archived = ok(await runCli(root, ['archive', '--change', CHANGE]), 'archive');
    expect(archived.data.specs).toEqual(['xforge/specs/widget/spec.md']);

    expect(await exists(path.join(root, ...CHANGE_PATH.split('/')))).toBe(false);
    const archiveNames = await readdir(path.join(root, 'xforge', 'changes', 'archive'));
    expect(archiveNames).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}-harden-widget$/)]);
    expect(await readFile(path.join(root, 'xforge', 'specs', 'widget', 'spec.md'), 'utf8')).toContain('### Requirement: Widget bounds input');
    /* The review transcript and both receipt sets travelled with the Change. */
    const archiveRoot = path.join(root, 'xforge', 'changes', 'archive', archiveNames[0]!);
    expect(await exists(path.join(archiveRoot, 'approvals', 'closing-major'))).toBe(true);
    expect(await exists(path.join(archiveRoot, 'evidence', 'review', 'change-review.md'))).toBe(true);

    const audit = ok(await runCli(root, ['audit', 'verify']), 'audit verify');
    expect(audit.data.valid).toBe(true);
  });
});
