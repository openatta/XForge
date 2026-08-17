/**
 * Deciding whether a Stage that produced no Artifact stopped correctly or simply failed.
 *
 * The two look identical from the filesystem, and the harness used to read every absence as a
 * defect. `quick-undeclared`'s Verify Agent refused to write `assurance.md` because its content
 * would have to map Requirements to test evidence that does not exist — the strongest form of the
 * behaviour that scenario exists to test — and the run died on the missing file one Stage before
 * the archive-path detection could recognise the stop.
 *
 * Absence alone can never be the test, because a broken run shows exactly the same thing. What
 * separates them is that the CLI is refusing, right now, for the reason the scenario predicted.
 */
export const VERIFICATION_NOT_DECLARED = 'XFORGE_VERIFICATION_NOT_DECLARED';

/**
 * @param {object} input
 * @param {boolean} input.artifactExists  whether the Stage's declared Artifact is on disk
 * @param {string[]} input.allowedOutcomes  outcomes the scenario declared acceptable up front
 * @param {{code?: string}[] | null | undefined} input.diagnostics  a live `xforge check` result
 */
export function stoppedAwaitingDeclaration({ artifactExists, allowedOutcomes, diagnostics }) {
  /* An Artifact that exists is not a stop, whatever the Gates say — the Stage did its work, and a
     Gate refusing afterwards is a different situation with a different verdict. */
  if (artifactExists) return false;
  /* Only a scenario that declared this outcome in advance may be resolved into it. Inferring the
     expectation from the failure would let any run excuse itself by stalling. */
  if (!(allowedOutcomes ?? []).includes('stopped-awaiting-declaration')) return false;
  return (diagnostics ?? []).some((item) => item?.code === VERIFICATION_NOT_DECLARED);
}
