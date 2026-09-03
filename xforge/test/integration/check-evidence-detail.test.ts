import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli } from '../helpers.js';

/**
 * What `check` returns inline, and what it must never lose by returning less.
 *
 * A Gate's Evidence carries the whole stdout and stderr of the command it ran, and `check` used to
 * return all of it — 90% of every gate entry, for output already written byte for byte to the file
 * the receipt cites. A Stage runs `check` three or four times, so the same test output arrived
 * three or four times and was re-sent with every turn after that. Across twenty recorded runs the
 * CLI's own replies were a fifth of everything entering the model's context.
 *
 * Narrowing a reply is only safe while the narrowing is invisible to every decision made from it.
 * These fix that: the verdict, the diagnostics, and the warning lift are identical either way.
 */
describe('check evidence detail', () => {
  it('reaches the same verdict and the same diagnostics either way', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);

    const summary = await runCli(root, ['check', '--change', 'add-feature']);
    const full = await runCli(root, ['check', '--change', 'add-feature', '--evidence-detail', 'full']);

    expect(summary.code).toBe(full.code);
    const verdicts = (result: typeof summary) => (result.json.data as any).gates.map((gate: any) => [gate.id, gate.status]);
    expect(verdicts(summary)).toEqual(verdicts(full));
    const codes = (result: typeof summary) => (result.json.diagnostics as Array<{ code: string }>).map((entry) => entry.code).sort();
    expect(codes(summary)).toEqual(codes(full));
    expect(summary.stdout.length).toBeLessThan(full.stdout.length);
  });

  it('says where the whole record is, and keeps the first line of what was printed', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const summary = await runCli(root, ['check', '--change', 'add-feature']);
    const gate = (summary.json.data as any).gates.find((entry: any) => entry.id === 'structure');

    expect(gate.evidence.evidencePath).toContain('evidence/');
    expect(gate.evidence.omitted).toContain('evidencePath');
    /* Enough to read what it said without a second call; not enough to stand in for the record. */
    expect(Array.isArray(gate.evidence.outputLines)).toBe(true);
    expect(gate.evidence.stdout).toBeUndefined();
    expect(gate.evidence.digest).toBeTruthy();
  });

  it('refuses a detail level that is not one of the two', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, ['check', '--change', 'add-feature', '--evidence-detail', 'stdout']);
    expect(result.code).toBe(1);
    expect((result.json.diagnostics as Array<{ code: string }>).map((entry) => entry.code))
      .toContain('XFORGE_OPTION_VALUE_INVALID');
  });
});
