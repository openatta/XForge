import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_NOT_DECLARED, refusedForDeclaration, stoppedAwaitingDeclaration,
  stoppedAwaitingDeclarationAtStart,
} from './live-engine/outcome.mjs';

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

/**
 * The first-Transition form of the same stop, and the boundary that broke it.
 *
 * A required declared Gate with no command now blocks the Change's *first* Transition, so
 * `quick-undeclared` stops at Propose with its Artifacts written rather than at Verify with one
 * missing. The predicate that recognises it reads the refusal's message, and the first live run
 * found the flaw: `transition.ts` writes the token into a sentence, so it is followed by a full
 * stop. The pattern anchored on whitespace-or-end, returned false, and the runner fell through to
 * its `Agent did not self-transition` throw — reporting an Agent that had behaved exactly as
 * intended as a delinquent one, on a run that cost real money to produce.
 *
 * The exact message is pinned here rather than a paraphrase of it. A paraphrase is what let the
 * first version pass its own author's reading.
 */
describe('recognising the refusal at the first Transition', () => {
  const REAL = 'Transition is blocked by verification:unit-tests:undeclared.';
  const allowed = ['stopped-awaiting-declaration'];

  it('reads the token out of the sentence the CLI actually writes', () => {
    expect(refusedForDeclaration([{ severity: 'error', message: REAL }])).toBe(true);
    expect(stoppedAwaitingDeclarationAtStart({
      allowedOutcomes: allowed, diagnostics: [{ severity: 'error', message: REAL }],
    })).toBe(true);
  });

  it('reads more than one Gate from one refusal', () => {
    /* Major names two, and a run that declared only the first would meet the second later. */
    expect(refusedForDeclaration([{
      severity: 'error',
      message: 'Transition is blocked by verification:unit-tests:undeclared, verification:security-scan:undeclared.',
    }])).toBe(true);
  });

  it('refuses to resolve when anything else is blocking too', () => {
    /* A Stage held by an unwritten Artifact *and* this block has not demonstrated the behaviour —
       it has demonstrated an Agent that stopped early and happened to have this underneath. */
    expect(refusedForDeclaration([
      { severity: 'error', message: REAL },
      { severity: 'error', message: 'Transition is blocked by artifact:proposal.' },
    ])).toBe(false);
    expect(refusedForDeclaration([{ severity: 'error', message: 'Transition is blocked by artifact:proposal.' }])).toBe(false);
  });

  it('does not match a longer token that merely starts the same way', () => {
    expect(refusedForDeclaration([{ severity: 'error', message: 'blocked by verification:x:undeclaredish.' }])).toBe(false);
  });

  it('needs a refusal, not a notice', () => {
    /* The two `info` diagnostics that carry the declare remedy accompany every such block; reading
       them as the refusal would resolve a run that was never actually stopped. */
    expect(refusedForDeclaration([{ severity: 'info', message: REAL }])).toBe(false);
  });

  it('resolves only for a scenario that declared the outcome up front', () => {
    expect(stoppedAwaitingDeclarationAtStart({
      allowedOutcomes: ['archived'], diagnostics: [{ severity: 'error', message: REAL }],
    })).toBe(false);
  });
});
