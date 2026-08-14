import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateVerificationReceipt } from '../../src/core/verification-receipt.js';
import { loadProject } from '../../src/core/project-loader.js';
import type { GateEvidence, ProjectContext } from '../../src/types.js';
import {
  advanceSolidToApply,
  approvalTestEnv,
  createCompleteSolidChange,
  fixture,
  runCli,
  updateYaml,
  write,
} from '../helpers.js';

const CHANGE = 'add-feature';
const RECEIPT = `xforge/changes/${CHANGE}/evidence/verification-receipt.yaml`;
const CONTENT_REVISION = 'a'.repeat(64);
const GIT_HEAD = 'c0ffee'.repeat(6) + 'abcd';

/**
 * Only the fields the receipt is decided against; the rest of a real GateEvidence is irrelevant here.
 * Citations name `inputDigest` — what the Gate verified — rather than `digest`, which also covers
 * timestamps and therefore changes when archive re-runs the Gate set. The two differ here on purpose.
 */
function evidence(gate: string, inputDigest: string, gitHead = GIT_HEAD): GateEvidence {
  return {
    gate, change: CHANGE, inputDigest, digest: `9${inputDigest.slice(1)}`,
    gitHead, status: 'passed', contentRevision: CONTENT_REVISION,
  } as unknown as GateEvidence;
}

async function project(): Promise<{ project: ProjectContext; root: string }> {
  const root = await fixture();
  await createCompleteSolidChange(root);
  return { project: await loadProject(root, { exactRoot: true }), root };
}

const gates = [evidence('structure', 'd'.repeat(64)), evidence('unit-tests', 'e'.repeat(64))];

function receiptYaml(overrides: Record<string, unknown> = {}): string {
  const document: Record<string, unknown> = {
    status: 'passed',
    contentRevision: CONTENT_REVISION,
    gitHead: GIT_HEAD,
    gates: gates.map((item) => ({ gate: item.gate, inputDigest: item.inputDigest, status: 'passed' })),
    ...overrides,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/*
 * `verification-receipt` is required by all three shipped Flows, and its only check was "the file
 * exists and is not empty" — `echo x > evidence/verification-receipt.yaml` closed the last Stage
 * before archive. These pin what the receipt now has to be a receipt *for*.
 */
describe('verification receipt ledger', () => {
  it('refuses a file that says nothing, and a self-reported pass that cites nothing', async () => {
    const { project: context, root } = await project();
    const expected = { contentRevision: CONTENT_REVISION, gates };

    /* Exactly what the fixture (and the shipped flow text) used to be enough to write. */
    await write(root, RECEIPT, 'x\n');
    expect((await evaluateVerificationReceipt(context, CHANGE, expected)).reason).toBe('receipt-unreadable');

    await write(root, RECEIPT, '\n');
    expect((await evaluateVerificationReceipt(context, CHANGE, expected)).reason).toBe('receipt-empty');

    await write(root, RECEIPT, 'status: passed\nrevision: fixture\n');
    expect((await evaluateVerificationReceipt(context, CHANGE, expected)).reason).toBe('content-revision-missing');

    await write(root, RECEIPT, receiptYaml({ gates: undefined }));
    expect((await evaluateVerificationReceipt(context, CHANGE, expected)).reason).toBe('gates-missing');
  });

  it('binds the receipt to the current content revision and to the Evidence that actually passed', async () => {
    const { project: context, root } = await project();
    const expected = { contentRevision: CONTENT_REVISION, gates };

    await write(root, RECEIPT, receiptYaml());
    expect(await evaluateVerificationReceipt(context, CHANGE, expected)).toMatchObject({ status: 'passed', reason: 'satisfied' });

    /* Editing the Change after the receipt was written makes it a receipt for something else. */
    const moved = await evaluateVerificationReceipt(context, CHANGE, { ...expected, contentRevision: 'b'.repeat(64) });
    expect(moved.status).toBe('failed');
    expect(moved.reason).toBe('content-revision-stale');

    /* A Gate that ran and passed cannot be left out: omitting it is how a failing Stage looks clean. */
    await write(root, RECEIPT, receiptYaml({ gates: [{ gate: 'structure' }] }));
    const omitted = await evaluateVerificationReceipt(context, CHANGE, expected);
    expect(omitted.status).toBe('failed');
    expect(omitted.reason).toBe('gate-uncited-unit-tests');

    /*
     * Citations carry no per-Gate digest, deliberately, and this pins why: an extra field naming a
     * run is ignored rather than trusted. Every digest reachable here moves under ordinary progress
     * — the Evidence digest covers timestamps that archive's re-run rewrites, and `inputDigest`
     * covers `stateRevision`, which changes on the very transition this receipt is written to
     * unblock — so comparing one would make a correct receipt fail a moment after it was written.
     * `contentRevision` above is what binds the receipt to the content it describes.
     */
    await write(root, RECEIPT, receiptYaml({ gates: gates.map((item) => ({ gate: item.gate, inputDigest: 'f'.repeat(64) })) }));
    expect((await evaluateVerificationReceipt(context, CHANGE, expected)).status).toBe('passed');

    /* A Gate the Stage has no passing, current Evidence for is not made current by citing it. */
    await write(root, RECEIPT, receiptYaml({ gates: [...gates.map((item) => ({ gate: item.gate, inputDigest: item.inputDigest })), { gate: 'security-scan', inputDigest: 'a'.repeat(64) }] }));
    expect((await evaluateVerificationReceipt(context, CHANGE, expected)).reason).toBe('gate-unverifiable-security-scan');
  });

  it('requires gitHead but does not compare it, because every commit moves it', async () => {
    const { project: context, root } = await project();
    const expected = { contentRevision: CONTENT_REVISION, gates };

    await write(root, RECEIPT, receiptYaml({ gitHead: '' }));
    expect((await evaluateVerificationReceipt(context, CHANGE, expected)).reason).toBe('git-head-missing');

    /*
     * A live run established that requiring the receipt's gitHead to equal the commit the Evidence
     * ran at is unsatisfiable in the ordinary sequence: the Stage's work is committed and only then
     * are the Gates regenerated, so the receipt's HEAD is the parent of the Evidence's. An
     * integrator merge does the same. `core/revision.ts` treats gitHead as audit metadata for
     * exactly this reason — a commit that changes no governed content is not staleness — and
     * `contentRevision`, checked above, is the commit-independent binding that carries the weight.
     */
    await write(root, RECEIPT, receiptYaml({ gitHead: 'deadbeef' }));
    expect((await evaluateVerificationReceipt(context, CHANGE, expected)).status).toBe('passed');
  });
});

describe('verification receipt as a Stage exit condition', () => {
  /*
   * The Flow wiring this expects, and the reason the receipt has to stop being a content-governing
   * Artifact: its own bytes feed `contentRevision` (`core/revision.ts` digests every Artifact
   * output), so a receipt that states the digest of a set it belongs to has no fixed point and
   * writing it would make every Gate that just passed `stale`.
   */
  it('blocks the close of Verify until the receipt names the revision and the Evidence', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
      flow.artifacts = flow.artifacts.filter((artifact: any) => artifact.id !== 'verification-receipt');
      const verify = flow.stages.find((stage: any) => stage.id === 'verify');
      verify.produces = ['assurance'];
      verify.exit = { conditions: { verificationReceipt: 'passed' } };
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    await advanceSolidToApply(root, CHANGE);
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify'], approvalTestEnv)).code).toBe(0);
    expect((await runCli(root, ['check', '--change', CHANGE])).code).toBe(0);

    const blockedFor = async (): Promise<string[]> => {
      const state = await runCli(root, ['state', '--change', CHANGE], approvalTestEnv);
      return (state.json.data.change.governance.readyTransitions as any[]).find((item) => item.to === 'ready-to-archive').blockedBy;
    };
    /* Nothing has written a receipt yet — the Stage cannot close on an absent one. This is the
       state a Change is in the moment `check` passes, which is exactly when the Skill tells the
       Agent to write it. */
    expect(await blockedFor()).toContain('condition:verificationReceipt:receipt-missing');

    const state = await runCli(root, ['state', '--change', CHANGE], approvalTestEnv);
    const contentRevision = state.json.data.change.governance.revision.contentRevision;
    const passed = await Promise.all(['structure.json', 'tests.json'].map(async (name) =>
      JSON.parse(await readFile(path.join(root, 'xforge', 'changes', CHANGE, 'evidence', name), 'utf8')) as GateEvidence));

    await write(root, RECEIPT, [
      'status: passed',
      `contentRevision: ${contentRevision}`,
      `gitHead: ${passed[0]!.gitHead}`,
      'gates:',
      ...passed.map((item) => `  - gate: ${item.gate}\n    inputDigest: ${item.inputDigest}\n    status: passed`),
      '',
    ].join('\n'));
    /* The receipt is no longer an Artifact output, so writing it does not move the content revision
       and does not make the Gates it cites stale — the property the Flow change exists to give. */
    expect(await blockedFor()).toEqual([]);
  });
});
