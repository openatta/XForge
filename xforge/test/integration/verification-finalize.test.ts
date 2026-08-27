import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { evaluateVerificationReceipt, VERIFICATION_RECEIPT_PATH } from '../../src/core/verification-receipt.js';
import { loadProject } from '../../src/core/project-loader.js';
import type { GateEvidence } from '../../src/types.js';
import { project } from '../project-builder.js';
import { fixture, runCli, updateYaml, write } from '../helpers.js';

const RECEIPT = VERIFICATION_RECEIPT_PATH;
const BY = 'owner@example.test';

interface AtVerify { root: string; change: string; }

/**
 * A Change at Verify with the Stage's Gates freshly run.
 *
 * The builder walks the Flow to `verify` and stops there, which is right: the Gates a Stage declares
 * are that Stage's work, so running `check` here is the fixture doing what an Agent does rather than
 * the builder pre-supposing it. Everything before this point — the Artifacts, the approvals, the
 * transitions — came from the Flow rather than from a copy of it.
 */
async function atVerify(): Promise<AtVerify> {
  const built = await project().flow('solid').atStage('verify').build();
  expect(built.stage).toBe('verify');
  const checked = await runCli(built.root, ['check', '--change', built.change]);
  expect(checked.code, JSON.stringify(checked.json?.diagnostics)).toBe(0);
  return { root: built.root, change: built.change };
}

async function receiptOnDisk(at: AtVerify): Promise<Record<string, any> | null> {
  try {
    const absolute = path.join(at.root, 'xforge', 'changes', at.change, ...RECEIPT.split('/'));
    return parse(await readFile(absolute, 'utf8')) as Record<string, any>;
  } catch { return null; }
}

/** What still blocks the Stage's forward transition — the only judge of a receipt that matters. */
async function blockedFor(at: AtVerify): Promise<string[]> {
  const state = await runCli(at.root, ['state', '--change', at.change]);
  return (state.json.data.change.governance.readyTransitions as any[]).find((item) => item.to === 'ready-to-archive').blockedBy;
}

function codes(result: any): string[] {
  return (result.json.diagnostics as any[]).map((item) => item.code);
}

function messages(result: any): string {
  return (result.json.diagnostics as any[]).map((item) => item.message).join('\n');
}

function finalize(at: AtVerify, ...extra: string[]): Promise<any> {
  return runCli(at.root, ['verification', 'finalize', '--change', at.change, '--status', 'passed', '--by', BY, ...extra]);
}

/**
 * Filing the receipt instead of dictating it.
 *
 * `draft-receipt` took the retyping out of the receipt but left the hand-write in: an Agent still
 * copied four computed fields into a file and added `status: passed`. A field report called that the
 * last hand-written file in the whole workflow, and therefore the last place a transcription error
 * can enter, and asked for an atomic finish. What makes it a `finalize` rather than a `write` is
 * that it re-reads every Gate it is about to cite before it cites it.
 */
describe('verification finalize', () => {
  it('writes the receipt from the same facts draft-receipt computes, and the Stage accepts it', async () => {
    const at = await atVerify();

    const drafted = await runCli(at.root, ['verification', 'draft-receipt', '--change', at.change]);
    expect(drafted.code, JSON.stringify(drafted.json?.diagnostics)).toBe(0);

    const finalized = await finalize(at);
    expect(finalized.code, JSON.stringify(finalized.json?.diagnostics)).toBe(0);

    /*
     * The reason the derivation is shared, asserted rather than assumed. Two implementations of
     * "which Gates does this Stage cite" would disagree invisibly, and the invisible disagreement is
     * the dangerous one: a receipt that looks complete and cites less than the Stage ran is exactly
     * what `evaluate()` exists to catch.
     */
    const draft = drafted.json.data.receipt as any;
    const written = (await receiptOnDisk(at))!;
    expect(written.change).toBe(draft.change);
    expect(written.contentRevision).toBe(draft.contentRevision);
    expect(written.gitHead).toBe(draft.gitHead);
    expect(written.gates).toEqual(draft.gates);

    /* Current facts, not whichever `contentRevision` a line-oriented read of `state` found first. */
    const state = await runCli(at.root, ['state', '--change', at.change]);
    expect(written.contentRevision).toBe(state.json.data.change.governance.revision.contentRevision);
    expect(written.gitHead).toBeTruthy();
    expect((written.gates as any[]).map((item) => item.gate).sort()).toEqual(['structure', 'unit-tests']);
    /* Citations name the Gate and nothing else — a digest here would be wrong for the reasons
       `core/verification-receipt.ts` sets out, and copying one is what the live run actually did. */
    for (const citation of written.gates as any[]) expect(Object.keys(citation).sort()).toEqual(['gate', 'status']);

    /* The one field that is nobody's computation, and the name attached to it. */
    expect(written.status).toBe('passed');
    expect(written.finalizedBy).toBe(BY);
    expect(Number.isNaN(Date.parse(written.finalizedAt))).toBe(false);
    expect(finalized.json.data.confirmedGates.sort()).toEqual(['structure', 'unit-tests']);
    expect(finalized.json.changes).toEqual([expect.objectContaining({ action: 'create', path: `xforge/changes/${at.change}/${RECEIPT}`, source: 'verification:finalize' })]);

    /*
     * The proof is not the file's shape but the evaluator's verdict, and then the Stage's: the
     * receipt satisfies the exit condition, and writing it moved no content revision and so staled
     * none of the Gates it cites — the property the Flow change exists to give.
     */
    const context = await loadProject(at.root, { exactRoot: true });
    const passed = await Promise.all(['structure.json', 'tests.json'].map(async (name) =>
      JSON.parse(await readFile(path.join(at.root, 'xforge', 'changes', at.change, 'evidence', name), 'utf8')) as GateEvidence));
    const evaluated = await evaluateVerificationReceipt(context, at.change, { contentRevision: written.contentRevision, gates: passed });
    expect(evaluated.problems).toEqual([]);
    expect(evaluated.status).toBe('passed');
    expect(await blockedFor(at)).toEqual([]);
  }, 300_000);

  /*
   * The refusal that makes this a verification rather than a transcription with better ergonomics.
   * Gate Evidence binds to the content revision, so an Agent that runs the Gates and then writes an
   * Artifact has stranded them while every Evidence file still reads `passed`. Transcribing at that
   * point produces a receipt vouching for content no Gate ever saw.
   */
  it('refuses a Gate gone stale, wording it as check does and naming the re-run', async () => {
    const at = await atVerify();
    /* `assurance.md` is a declared output of this Stage, so touching it moves the content revision:
       the ordinary mid-Stage edit, not a contrived one. */
    await write(at.root, `xforge/changes/${at.change}/assurance.md`, '## Completeness\n\nRecorded for the fixture, and one sentence more.\n');

    /* The same condition `check` warns about while the Gates are still in front of you. The two must
       not describe it differently, or one fact reads as two problems. */
    const warned = await runCli(at.root, ['check', '--change', at.change, '--gate', 'structure']);
    expect(codes(warned)).toContain('XFORGE_GATE_EVIDENCE_STALE');

    const refused = await finalize(at);
    expect(refused.code).toBe(1);
    expect(codes(refused)).toContain('XFORGE_VERIFICATION_FINALIZE_GATE_UNCONFIRMED');
    const stale = (refused.json.diagnostics as any[]).find((item) => item.message.startsWith('Gate unit-tests '));
    /* The mechanism, in the same words check gives it, down to the reassurance that carries the
       whole diagnosis: re-run it, do not go looking for a defect. */
    expect(stale.message).toContain('Gate Evidence binds to the Change\'s content at the moment the Gate runs');
    expect(stale.message).toContain('nothing else about this Gate is wrong');
    expect(stale.message).toContain(`xforge check --change ${at.change} --gate unit-tests`);
    expect(stale.message).not.toContain('fix what the Gate found');
    /* And it is located, so a consumer can act on it rather than only read it. */
    expect(stale.path).toBe(`xforge/changes/${at.change}`);

    /* Refused means nothing written, not written and then rejected downstream. */
    expect(await receiptOnDisk(at)).toBeNull();
  }, 300_000);

  /* A Gate that never ran needs a first run, which is not the same instruction as a re-run. */
  it('refuses a Gate with no Evidence, and tells it apart from a stale one', async () => {
    const at = await atVerify();
    await rm(path.join(at.root, 'xforge', 'changes', at.change, 'evidence', 'structure.json'));

    const refused = await finalize(at);
    expect(refused.code).toBe(1);
    expect(codes(refused)).toContain('XFORGE_VERIFICATION_FINALIZE_GATE_UNCONFIRMED');
    const missing = (refused.json.diagnostics as any[]).find((item) => item.message.startsWith('Gate structure '));
    expect(missing.message).toContain('a first run, not a re-run');
    expect(missing.message).toContain(`xforge check --change ${at.change} --gate structure`);
    expect(await receiptOnDisk(at)).toBeNull();
  }, 300_000);

  /* And a Gate that ran and did not pass needs its finding fixed — the third of the three. */
  it('refuses a Gate that ran and did not pass, and asks for the finding rather than a re-run', async () => {
    const at = await atVerify();
    await updateYaml(at.root, 'xforge/manifest.yaml', (manifest) => {
      manifest.verification['unit-tests'] = [{
        command: ['node', '-e', 'process.exit(1)'],
        declaredBy: BY,
        declaredAt: '2026-01-01T00:00:00Z',
      }];
    });
    /* Expected to exit non-zero: the Gate is meant to fail, and what matters is the Evidence it
       leaves behind — Evidence bound to the current revision that reports a failure. */
    await runCli(at.root, ['check', '--change', at.change, '--gate', 'unit-tests']);

    const refused = await finalize(at);
    expect(refused.code).toBe(1);
    const failed = (refused.json.diagnostics as any[]).filter((item) => item.message.startsWith('Gate unit-tests '));
    expect(failed.map((item) => item.code)).toEqual(['XFORGE_VERIFICATION_FINALIZE_GATE_UNCONFIRMED']);
    expect(failed[0].message).toContain('fix what the Gate found');
    /* Said outright, because the stale message right above it prescribes exactly that and the two
       are one keystroke apart in the output. */
    expect(failed[0].message).toContain('re-running alone will not clear it');
    expect(await receiptOnDisk(at)).toBeNull();
  }, 300_000);

  /*
   * Every other command in this product answers "what would this do" with its plan. An empty
   * `changes` list reads as "this would change nothing", which for the one command whose whole job
   * is to write a file would be a lie.
   */
  it('reports the plan under --dry-run and writes nothing', async () => {
    const at = await atVerify();

    const planned = await finalize(at, '--dry-run');
    expect(planned.code, JSON.stringify(planned.json?.diagnostics)).toBe(0);
    expect(planned.json.data.dryRun).toBe(true);
    expect(planned.json.changes.map((item: any) => item.path)).toEqual([`xforge/changes/${at.change}/${RECEIPT}`]);
    expect(planned.json.changes[0].action).toBe('create');
    expect(planned.json.changes[0].digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await receiptOnDisk(at)).toBeNull();
    /* The Stage is exactly as blocked as it was, because nothing happened. */
    expect(await blockedFor(at)).toContain('condition:verificationReceipt:receipt-missing');

    /* The same call without the flag then does what the plan said. */
    expect((await finalize(at)).code).toBe(0);
    expect((await receiptOnDisk(at))!.status).toBe('passed');
    /*
     * Second time round the plan says `modify`, which is the honest verb: finalize overwrites, and
     * that is what makes it the repair path for a receipt somebody wrote by hand and got wrong.
     */
    expect((await finalize(at, '--dry-run')).json.changes[0].action).toBe('modify');
  }, 300_000);

  /* A receipt records an assertion somebody made. An unsigned one records an assertion nobody made. */
  it('requires a person and a stated assertion, on the same terms as declare and retire', async () => {
    const root = await fixture();

    const nameless = await runCli(root, ['verification', 'finalize', '--change', 'add-feature', '--status', 'passed']);
    expect(nameless.code).toBe(1);
    expect(codes(nameless)).toContain('XFORGE_VERIFICATION_ARGUMENTS_REQUIRED');
    expect(nameless.json.diagnostics[0].message).toContain('has to carry a name');

    const silent = await runCli(root, ['verification', 'finalize', '--change', 'add-feature', '--by', BY]);
    expect(silent.code).toBe(1);
    expect(codes(silent)).toContain('XFORGE_VERIFICATION_ARGUMENTS_REQUIRED');

    const changeless = await runCli(root, ['verification', 'finalize', '--status', 'passed', '--by', BY]);
    expect(changeless.code).toBe(1);
    expect(codes(changeless)).toContain('XFORGE_CHANGE_REQUIRED');
  });

  /*
   * There is no second status. The receipt is a positive assertion that the Stage verified the work;
   * a Stage that did not verify leaves it absent, and the resulting blocked exit is the accurate
   * record of a Change nobody has verified.
   */
  it('writes only a passed receipt, and takes --status nowhere else', async () => {
    const root = await fixture();

    const refused = await runCli(root, ['verification', 'finalize', '--change', 'add-feature', '--status', 'failed', '--by', BY]);
    expect(refused.code).toBe(1);
    expect(codes(refused)).toContain('XFORGE_VERIFICATION_STATUS_UNSUPPORTED');
    expect(messages(refused)).toContain('passed is the only status this writes');

    /* Refused before the Change is even resolved, so the option cannot be read as a filter over
       something that exists — there is no `add-feature` in this fixture at all. */
    const misplaced = await runCli(root, ['verification', 'draft-receipt', '--change', 'add-feature', '--status', 'passed']);
    expect(misplaced.code).toBe(1);
    expect(codes(misplaced)).toContain('XFORGE_OPTION_NOT_ALLOWED');
  });
});
