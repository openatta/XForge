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
 * The same question asked earlier, which is now where it is usually met.
 *
 * A required declared Gate with no command blocks the Change's *first* Transition, so the normal
 * stopping point moved from the Stage that runs the Gate to Propose. The two shapes have almost
 * nothing in common on disk: at Propose the Gate has never run, so there is no Evidence file to
 * read, the Artifacts the Stage owed are all written, and the only trace is the refused Transition.
 * Reading only the old shape would have turned every correct stop into a harness error.
 */
export const VERIFICATION_UNDECLARED_BLOCKS_START = 'XFORGE_VERIFICATION_UNDECLARED_BLOCKS_START';

/**
 * The `blockedBy` token the first-Transition refusal carries, per Gate.
 *
 * Bounded on the right by a negative lookahead rather than by `(\s|$)`, and the first live run is
 * what forced that. `transition.ts` writes the token into a sentence — `Transition is blocked by
 * verification:unit-tests:undeclared.` — so it is followed by a full stop, which is neither
 * whitespace nor end-of-string. The predicate returned false, the runner fell through to the
 * `Agent did not self-transition` throw, and a run whose Agent had behaved exactly as intended was
 * reported as a delinquent Agent. The anchor was guarding against `:undeclared` being the prefix of
 * a longer token; the lookahead guards that without assuming the token ends the string it sits in.
 *
 * `.` is deliberately absent from the lookahead's class although it is present in the gate-id class
 * above. The token's suffix is the fixed word `undeclared`, so nothing of the token can follow it —
 * and a full stop is exactly what does follow it in the CLI's sentence. Including `.` here would
 * reintroduce the same failure in a subtler form, which is what the first attempt at this fix did.
 */
export const UNDECLARED_BLOCK = /verification:[A-Za-z0-9][A-Za-z0-9._-]*:undeclared(?![A-Za-z0-9_-])/;

/**
 * Whether a refused Transition was refused for want of a declaration, and nothing else.
 *
 * "And nothing else" is the whole of it. A Stage blocked by an unwritten Artifact *and* an
 * undeclared Gate has not demonstrated the behaviour this outcome records — it has demonstrated an
 * Agent that stopped early for its own reasons and happened to have this block underneath. So every
 * error the probe reports must be this one.
 *
 * @param {{code?: string, severity?: string, message?: string}[] | null | undefined} diagnostics
 */
export function refusedForDeclaration(diagnostics) {
  const errors = (diagnostics ?? []).filter((item) => item?.severity === 'error');
  if (errors.length === 0) return false;
  return errors.every((item) => UNDECLARED_BLOCK.test(String(item.message ?? '')));
}

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

/**
 * The first-Transition form: Artifacts written, Transition refused, nothing else blocking.
 *
 * Deliberately not folded into `stoppedAwaitingDeclaration` above. That one keys on an Artifact
 * being *absent* — a Verify Agent that could not honestly write `assurance.md` — and this one
 * requires the Artifacts to be *present*, because a Propose Agent that stopped correctly still owed
 * and wrote its Proposal and delta Specs. One predicate covering both would have to accept an
 * absent Artifact here, which is the case that must stay a failure.
 *
 * @param {object} input
 * @param {string[]} input.allowedOutcomes
 * @param {{code?: string, severity?: string, message?: string}[] | null | undefined} input.diagnostics
 */
export function stoppedAwaitingDeclarationAtStart({ allowedOutcomes, diagnostics }) {
  if (!(allowedOutcomes ?? []).includes('stopped-awaiting-declaration')) return false;
  return refusedForDeclaration(diagnostics);
}
