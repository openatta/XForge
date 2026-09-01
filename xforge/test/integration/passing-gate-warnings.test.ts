import { describe, expect, it } from 'vitest';
import { advanceSolidToApply, createCompleteSolidChange, fixture, runCli } from '../helpers.js';

/**
 * A Gate that passed and had something to say.
 *
 * `core/ledger.ts`'s `ledgerReport` is the one renderer for a ledger Gate's output, and on a pass
 * it prefixes every warning with `warning: ` into stdout — which lands in Evidence and nowhere
 * else. So `constitution-check` could pass while printing "principle X cannot be cross-checked"
 * into its own Evidence, and the envelope reported `diagnostics: []` with no
 * XFORGE_CHECK_PASSED_WITH_WARNINGS: the notice whose whole sentence is "a passing Gate is not a
 * clean check" was blind to exactly the case it names.
 *
 * Three hand-driven runs found these only by opening `evidence/*.json`, and each reported it as a
 * finding. A reader who never opens those files is the reader this is for.
 */
describe('warnings a passing Gate carries', () => {
  const CHANGE = 'add-feature';

  it('reaches diagnostics, and makes the passed-with-warnings notice fire', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    await advanceSolidToApply(root, CHANGE);

    /* At Check, constitution-check passes and defers its observability cross-check — the warning
       that used to exist only inside evidence/constitution-check.json. */
    const ran = await runCli(root, ['check', '--change', CHANGE, '--stage', 'check']);
    const codes = (ran.json.diagnostics as any[]).map((item) => item.code);

    const carried = (ran.json.diagnostics as any[]).filter((item) => item.code === 'XFORGE_GATE_PASSED_WITH_WARNINGS');
    expect(carried.length, JSON.stringify(codes)).toBeGreaterThan(0);
    expect(carried[0].severity).toBe('warning');
    expect(carried.map((item: any) => item.message).join(' ')).toContain('constitution-check');
    /* And the notice that exists to say a passing Gate is not a clean check now sees it. */
    expect(codes).toContain('XFORGE_CHECK_PASSED_WITH_WARNINGS');
  });

  it('says nothing when every passing Gate was silent', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    const ran = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    expect((ran.json.diagnostics as any[]).map((item) => item.code))
      .not.toContain('XFORGE_GATE_PASSED_WITH_WARNINGS');
  });
});
