import { describe, expect, it } from 'vitest';
import { blockRemedy } from '../../src/core/control-plane.js';

/**
 * The path the independent-review remedy names, checked against the path the CLI accepts.
 *
 * The per-package branch said `evidence/agents/<package>/review-<execution>.yaml`. That matches
 * `evidence/agents/<package>/*.yaml`, which is the delivery-record namespace: a transcript written
 * there is validated as a delivery, and a read-only review has no honest `status` in that envelope
 * and no `changed_paths` to give. `xforge-apply` step 8 spells the working path and says both the
 * `review/` subdirectory and the `.md` are load-bearing. Following the CLI's own remedy earned
 * `XFORGE_WORK_PACKAGE_DELIVERY_SLOT_MISUSED` — the refusal a `skill-cli-contract` test already
 * exists to prevent, arriving this time from the CLI's own advice rather than a Skill's.
 *
 * The Change-level branch a few lines below always had it right, which is what made the split
 * visible: one function, two remedies for the same condition, and only one of them runnable.
 */
describe('the independent-review remedy', () => {
  it('names the review path for a package, not the delivery slot', () => {
    const remedy = blockRemedy(['condition:independentReview:unreviewed-T001'], 'credential-store');
    expect(remedy?.code).toBe('XFORGE_INDEPENDENT_REVIEW_REMEDY');
    expect(remedy!.message).toContain('evidence/agents/<package>/review/<execution>.md');
    /* The shape that is read as a delivery record must not be what it tells you to write. */
    expect(remedy!.message).not.toContain('review-<execution>.yaml');
  });

  it('still names the Change-level path when there is no package to attach to', () => {
    const remedy = blockRemedy(['condition:independentReview:review-missing'], 'credential-store');
    expect(remedy?.code).toBe('XFORGE_INDEPENDENT_REVIEW_REMEDY');
    expect(remedy!.message).toContain('evidence/review/<name>.md');
  });
});
