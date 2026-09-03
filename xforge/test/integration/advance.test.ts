import { describe, expect, it } from 'vitest';
import { changeYaml, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

/**
 * `advance` runs the Gates and then transitions, and the second half is conditional on the first.
 *
 * The command exists because the pair was in every measured Stage — twelve runs across three Stages
 * ended with `check` immediately followed by `transition`, with no variance. Merging them saves one
 * call per Stage, and the whole value of that saving depends on it being impossible for the merge to
 * move a Change past a Gate that did not pass. That is what these assert: the records stay two
 * records, and a refusal stays a refusal.
 */
describe('xforge advance', () => {
  it('writes no transition receipt when a Gate refuses', async () => {
    const root = await fixture();
    /* A Change whose structure cannot pass: `change.yaml` alone, no Proposal, no delta Spec. */
    await write(root, 'xforge/changes/add-feature/change.yaml', changeYaml('solid'));

    const before = await runCli(root, ['state', '--change', 'add-feature', '--field', 'change.governance.currentStage']);
    const advanced = await runCli(root, ['advance', '--change', 'add-feature', '--to', 'design']);
    const after = await runCli(root, ['state', '--change', 'add-feature', '--field', 'change.governance.currentStage']);

    expect(advanced.json.data.transitioned).toBeNull();
    expect(after.stdout.trim()).toBe(before.stdout.trim());
  });

  it('keeps the Gate Evidence and the Transition receipt as two separate records', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);

    const advanced = await runCli(root, ['advance', '--change', 'add-feature', '--to', 'design']);
    expect(advanced.code).toBe(0);
    expect(advanced.json.data.transitioned).toBe('design');

    /* Both halves recorded, separately and in their own places — the thing a merged command must
       not lose, because "the Gate passed" and "the Stage moved" are different assertions. */
    const gates = advanced.json.data.gates as Array<{ id: string; status: string }>;
    expect(gates.find((gate) => gate.id === 'structure')?.status).toBe('passed');
    const receipts = await runCli(root, ['state', '--change', 'add-feature', '--field', 'change.governance.transitions']);
    expect(JSON.parse(receipts.stdout).count).toBeGreaterThan(0);
  });

  it('refuses to choose when more than one Transition is ready, and writes nothing', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await runCli(root, ['advance', '--change', 'add-feature', '--to', 'design']);

    /* At `design` both the forward move and the rework route back to `propose` are ready. Picking
       between them is a judgement, so it asks rather than defaulting. */
    const ambiguous = await runCli(root, ['advance', '--change', 'add-feature']);
    expect(ambiguous.json.data.transitioned).toBeNull();
    expect((ambiguous.json.diagnostics as Array<{ code: string }>).map((entry) => entry.code))
      .toContain('XFORGE_ADVANCE_NO_READY_TRANSITION');
  });
});
