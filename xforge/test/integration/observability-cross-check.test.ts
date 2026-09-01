import { describe, expect, it } from 'vitest';
import { CONSTITUTION_CHECK_PATH, constitutionPrinciples, evaluateConstitutionCheck } from '../../src/core/constitution-check.js';
import { loadProject } from '../../src/core/project-loader.js';
import { advanceSolidToApply, createCompleteSolidChange, fixture, runCli } from '../helpers.js';

/**
 * The cross-check the Constitution Gate defers, and where the answer actually arrives.
 *
 * `constitution-check` will not take an Agent's word that a principle about automated verification
 * is satisfied — it reads the `unit-tests` Gate Evidence and fails a `compliant` answer the
 * Evidence contradicts. On every shipped Flow that is impossible where the Gate lives: it runs at
 * the Check Stage, `unit-tests` runs at Verify after it, nothing re-runs a Check-Stage Gate, and
 * archive's mandatory set is the Verify Stage's. So the Gate said "it will be checked again once
 * the Gate has run" and no Stage ever did — every Solid and Major Change archived with the warning
 * standing and the answer never taken. A hand-driven run of all four Flows found it by reading the
 * Evidence file, because the warning does not reach `diagnostics` either.
 */
describe('the deferred observability cross-check', () => {
  const CHANGE = 'add-feature';

  it('does not promise a re-check that no Stage of the Flow performs', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await evaluateConstitutionCheck(await loadProject(root, { exactRoot: true }), CHANGE);
    const deferred = result.warnings.filter((warning) => warning.includes('cross-check'));
    expect(deferred.length, 'the Gate no longer defers anything').toBeGreaterThan(0);
    /* It may say where the answer arrives; it may not claim this Gate will take it. */
    expect(deferred.join(' ')).not.toContain('checked again once the Gate has run');
    expect(deferred.join(' ')).toContain('RC-8');
  });

  it('states the contradiction from the reconciliation pass, where the Evidence exists', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    await advanceSolidToApply(root, CHANGE);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']);
    /* A Gate that ran and did not pass — the case the Check Stage could never see, because
       unit-tests runs at the Stage after the one that reads its Evidence. */
    await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["node","-e","process.exit(1)"]', '--by', 'A Tester']);
    const ran = await runCli(root, ['check', '--change', CHANGE]);
    expect((ran.json.data as any)?.gates?.find((gate: any) => gate.id === 'unit-tests')?.status,
      JSON.stringify(ran.json.diagnostics)).toBe('failed');

    const principles = constitutionPrinciples((await loadProject(root, { exactRoot: true })).constitution.content);
    expect(principles.some((name) => /observab|automated verification|test/i.test(name)),
      'the shipped Constitution has no observability principle to answer').toBe(true);

    const observed = (ran.json.diagnostics as any[]).filter((item) => item.code === 'XFORGE_RECONCILE_OBSERVABILITY_UNVERIFIED');
    expect(observed.length, JSON.stringify((ran.json.diagnostics as any[]).map((item) => item.code))).toBeGreaterThan(0);
    expect(observed[0].message).toContain('unit-tests Gate Evidence now records status "failed"');
    /* Reconciliation states differences and never decides them: info, never a failure. */
    expect(observed[0].severity).toBe('info');
  });

  /**
   * The reason the rule above could not be observed at first: a failing Gate switched the whole
   * reconciliation pass off.
   *
   * `check` resolves the control plane after running the Gates, under a guard that read "no error
   * diagnostic so far". A mandatory Gate that fails pushes one, so `control` stayed null and
   * everything keyed on it was skipped — the delivery audit, the staleness notice, every
   * reconciliation rule, and the `answer-finding` actions that carry a Change's open questions to a
   * person. All of it went quiet on exactly the runs where a Change is in trouble. The right
   * predicate was already in scope and computed before the Gates ran.
   */
  it('still reconciles when a mandatory Gate failed', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    await advanceSolidToApply(root, CHANGE);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']);
    await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["node","-e","process.exit(1)"]', '--by', 'A Tester']);

    const ran = await runCli(root, ['check', '--change', CHANGE]);
    const codes = (ran.json.diagnostics as any[]).map((item) => item.code);
    expect(codes, 'the Gate was supposed to fail here').toContain('XFORGE_GATE_FAILED');
    /* Reconciliation ran anyway: any RC rule reporting proves the control plane was resolved. */
    expect(codes.filter((code: string) => code.startsWith('XFORGE_RECONCILE_')).length,
      JSON.stringify(codes)).toBeGreaterThan(0);
  });

  it('says nothing while the Gate passes', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    await advanceSolidToApply(root, CHANGE);
    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    expect((result.json.diagnostics as any[]).map((item) => item.code))
      .not.toContain('XFORGE_RECONCILE_OBSERVABILITY_UNVERIFIED');
  });
});
