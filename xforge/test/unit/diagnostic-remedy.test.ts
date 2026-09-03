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
});
