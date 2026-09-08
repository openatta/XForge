import { describe, expect, it } from 'vitest';
import { blockRemedy } from '../../src/core/control-plane.js';

/**
 * A remedy a reader can run, for the diagnostics that know one.
 *
 * Seven codes end in `_REMEDY` and every one of them delivered a paragraph: of 520 `diagnostic()`
 * sites in the product, the ones naming a command name it inside a sentence, so a reader has to
 * parse it back out. `message` is still the authority -- it says *why*, which no argv carries --
 * and this is the half that can be executed.
 *
 * Narrow on purpose. Most blocks have no command: the next step is work, or a decision, or a
 * person, and inventing an argv for those would be worse than the prose.
 */
describe('a block remedy that names commands', () => {
  it('names one dispatch per undispatched package, and the bind that follows them', () => {
    const remedy = blockRemedy(['work-package:T001:ready', 'work-package:T002:ready'], 'add-feature');
    expect(remedy?.code).toBe('XFORGE_WORK_PACKAGE_UNDISPATCHED_REMEDY');
    /* Every package, not the first: naming one would name a step that does not finish the job. */
    expect(remedy?.remedy?.commands).toEqual([
      ['xforge', 'work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'],
      ['xforge', 'work-package', 'dispatch', '--change', 'add-feature', '--package', 'T002'],
      ['xforge', 'check', '--change', 'add-feature'],
    ]);
  });

  it('names one acknowledgement per unreviewed package', () => {
    const remedy = blockRemedy(['condition:independentReview:unreviewed-T001+T002'], 'add-feature');
    expect(remedy?.code).toBe('XFORGE_INDEPENDENT_REVIEW_REMEDY');
    expect(remedy?.remedy?.commands).toEqual([
      ['xforge', 'work-package', 'acknowledge', '--change', 'add-feature', '--package', 'T001', '--as', 'reviewer', '--evidence', '<path>'],
      ['xforge', 'work-package', 'acknowledge', '--change', 'add-feature', '--package', 'T002', '--as', 'reviewer', '--evidence', '<path>'],
    ]);
  });

  /*
   * The half that matters as much: a block whose next step is human work must not grow an argv that
   * implies otherwise. This one needs a review to happen before anything can be recorded.
   */
  it('carries prose and no commands where the next step is not a command', () => {
    const remedy = blockRemedy(['condition:independentReview:review-missing'], 'add-feature');
    expect(remedy?.code).toBe('XFORGE_INDEPENDENT_REVIEW_REMEDY');
    expect(remedy?.remedy?.commands).toBeUndefined();
    expect(remedy?.message).toContain('reviewer');
  });

  /*
   * A ledger that is not on disk, which is the commonest condition block and had no remedy at all.
   *
   * `transition` refused with two bare tokens while `stage`, at the same Stage and the same moment,
   * reported the ledger among the Artifacts the Stage owes with the instruction and outline its
   * Flow declares. Whether the reader learned what to write depended on which command they reached
   * for. A walk of the Major Flow met this at clarify.
   *
   * The command is `stage` rather than a description of the ledger: the shape belongs to the Flow's
   * Artifact instruction, and a sentence here would duplicate it and then drift from it.
   */
  it('sends a missing condition ledger to the command that carries its shape', () => {
    const remedy = blockRemedy(['condition:materialQuestions:ledger-missing-expected-resolved'], 'add-feature');
    expect(remedy?.code).toBe('XFORGE_CONDITION_LEDGER_MISSING_REMEDY');
    expect(remedy?.remedy?.commands).toEqual([['xforge', 'stage', '--change', 'add-feature']]);
    /* The key and the status it must declare, both of which come out of the block token. */
    expect(remedy?.message).toContain('materialQuestions');
    expect(remedy?.message).toContain('status: resolved');
  });

  /*
   * A Stage blocked on both an absent ledger and a stale Gate still reports the Gate, because the
   * Gate branch comes first and this change did not reorder it. Recorded rather than asserted as
   * correct: on a Flow where the ledger is also an Artifact's output it is a content input, so
   * writing it stales the Gate again and the Gate advice is the half that has to be repeated. No
   * measured run has met the pair, and reordering on reasoning alone would be changing which
   * sentence a reader gets on the strength of a guess.
   */
  it('leaves the Gate remedy first when a Stage is blocked on both', () => {
    const remedy = blockRemedy(
      ['gate:unit-tests:stale', 'condition:materialQuestions:ledger-missing-expected-resolved'],
      'add-feature',
    );
    expect(remedy?.code).toBe('XFORGE_GATE_EVIDENCE_STALE_REMEDY');
  });
});
