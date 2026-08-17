import { describe, expect, it } from 'vitest';
import { VERIFICATION_NOT_DECLARED, stoppedAwaitingDeclaration } from './live-engine/outcome.mjs';

const refusing = [{ code: VERIFICATION_NOT_DECLARED, severity: 'error' }];
const allowed = ['stopped-awaiting-declaration'];

/**
 * `quick-undeclared` passes by stopping: its project never says how it runs its tests, nobody is
 * there to ask, and the Verify Agent must refuse rather than guess. On the run that prompted this,
 * it refused so completely that it wrote no `assurance.md` at all — its content would have had to
 * map Requirements to test evidence that does not exist.
 *
 * The harness failed the run on the missing file, one Stage before its archive-path detection could
 * recognise the stop. It had scored the strongest form of the behaviour it was built to reward as a
 * defect, which is the same shape as the other harness faults found here: what the test
 * infrastructure can represent decides which results are visible.
 */
describe('telling a correct stop from a failed Stage', () => {
  it('resolves the stop when the CLI is refusing for the declared reason', () => {
    expect(stoppedAwaitingDeclaration({
      artifactExists: false, allowedOutcomes: allowed, diagnostics: refusing,
    })).toBe(true);
  });

  it('does not resolve a stop from a missing Artifact alone', () => {
    /* Absence can never be the test on its own — a run that crashed mid-Stage looks identical from
       the filesystem, and reading that as a pass would make the scenario unable to fail. */
    expect(stoppedAwaitingDeclaration({
      artifactExists: false, allowedOutcomes: allowed, diagnostics: [],
    })).toBe(false);
    expect(stoppedAwaitingDeclaration({
      artifactExists: false, allowedOutcomes: allowed, diagnostics: [{ code: 'XFORGE_GATE_FAILED' }],
    })).toBe(false);
  });

  it('does not resolve a stop for a scenario that never declared the outcome', () => {
    /* Inferring the expectation from the failure would let any stalled run excuse itself. A
       scenario expecting `archived` must still fail when its Verify Agent produces nothing. */
    expect(stoppedAwaitingDeclaration({
      artifactExists: false, allowedOutcomes: ['archived'], diagnostics: refusing,
    })).toBe(false);
  });

  it('does not resolve a stop when the Artifact exists', () => {
    /* The Stage did its work; a Gate refusing afterwards is a different situation with a different
       verdict, and folding the two together would hide a real failure behind an expected one. */
    expect(stoppedAwaitingDeclaration({
      artifactExists: true, allowedOutcomes: allowed, diagnostics: refusing,
    })).toBe(false);
  });

  it('survives a check that returned nothing usable', () => {
    /* `tryXforgeJson` returns null on a CLI that could not answer, and a harness that throws while
       classifying a stop reports a crash where the run had a verdict. */
    for (const diagnostics of [undefined, null]) {
      expect(stoppedAwaitingDeclaration({ artifactExists: false, allowedOutcomes: allowed, diagnostics })).toBe(false);
    }
    expect(stoppedAwaitingDeclaration({ artifactExists: false, allowedOutcomes: undefined, diagnostics: refusing })).toBe(false);
  });
});
