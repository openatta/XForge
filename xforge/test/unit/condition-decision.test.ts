import { describe, expect, it } from 'vitest';
import { decideStageCondition } from '../../src/core/control-plane/conditions.js';
import type { ChangeState, Diagnostic } from '../../src/types.js';

/**
 * The exit-condition judgement, decided without a project on disk.
 *
 * This file is the point of the collect/decide split, not a side effect of it. Every assertion here
 * used to require a real project tree, a real Git worktree, and a walk through however many Stages
 * it took to reach the condition — which is why the suite has 82 integration files and 25 unit
 * files, and why the ledger's rules (what counts as decided, what a rework cutoff invalidates, what
 * an empty `entries: []` asserts) were tested at whatever depth an end-to-end walk happened to
 * reach. The rules are the intricate part; reaching them was the expensive part.
 *
 * **On `red-first`.** This is a coverage-only file in the sense that document describes: it proves
 * no fix, because the behaviour it pins is the behaviour that was already there. It *will* go red
 * against the parent commit, but for the wrong reason — `decideStageCondition` does not exist there
 * — so treat that green as the false one the test architecture warns about. What makes these
 * assertions worth having is that they are now cheap enough to write at all.
 */

const CHANGES = 'xforge/changes';

/** The identities a Change can attest, as `knownIdentities` reports them. */
function identities(values = new Set(['alex'])) {
  return { values, empty: false, actors: new Set<string>(), fallback: new Set<string>(), managed: false };
}

/** The condition inputs, as they arrive once collection has finished. */
function sources(ledger?: unknown) {
  return {
    ledgers: new Map(ledger === undefined ? [] : [['materialQuestions', { kind: 'document' as const, document: ledger }]]),
    receipt: { kind: 'unusable' as const, relative: 'unused', reason: 'receipt-missing', problems: [] },
    reviews: { receipts: [], diagnostics: [] },
  };
}

function decide(ledger: unknown, options: { diagnostics?: Diagnostic[]; reworkCutoff?: { at: number; receiptId: string } | null; known?: Set<string> } = {}) {
  return decideStageCondition(CHANGES, 'add-feature', 'materialQuestions', 'resolved', {
    state: { id: 'add-feature', artifacts: [] } as unknown as ChangeState,
    workPackages: { status: 'absent', state: null, diagnostics: [] },
    contentRevision: 'sha256:content',
    gates: [],
    identities: identities(options.known),
    diagnostics: options.diagnostics ?? [],
    reworkCutoff: options.reworkCutoff ?? null,
    sources: sources(ledger),
  });
}

const DECIDED = {
  id: 'q1',
  question: 'Does the grace period stay?',
  decision: 'No grace period.',
  decidedBy: 'alex',
  decidedAt: '2026-03-01T00:00:00Z',
};

describe('exit condition decision', () => {
  it('accepts a ledger whose every entry is decided by somebody the Change can attest', () => {
    expect(decide({ condition: 'materialQuestions', status: 'resolved', entries: [DECIDED] }))
      .toEqual({ satisfied: true, reason: 'satisfied' });
  });

  /*
   * The unit-level statement of what a clock read cannot do.
   *
   * `decidedAt` moves freely and is written by the party this condition constrains; only the
   * receipt id, which has to be read out of a digest-linked chain, clears a rework.
   */
  it('clears a rework only when the entry names the receipt that caused it', () => {
    const cutoff = { at: Date.parse('2026-03-02T00:00:00Z'), receiptId: 'r-2' };
    /* Decided before the rework, no anchor: stale. */
    expect(decide({ status: 'resolved', entries: [DECIDED] }, { reworkCutoff: cutoff }))
      .toEqual({ satisfied: false, reason: 'stale-q1' });
    /* A timestamp moved past the rework, still no anchor: exactly as stale. */
    expect(decide({ status: 'resolved', entries: [{ ...DECIDED, decidedAt: '2026-03-03T00:00:00Z' }] }, { reworkCutoff: cutoff }))
      .toEqual({ satisfied: false, reason: 'stale-q1' });
    /* The wrong receipt is not an anchor either. */
    expect(decide({ status: 'resolved', entries: [{ ...DECIDED, decidedAfter: 'r-1' }] }, { reworkCutoff: cutoff }))
      .toEqual({ satisfied: false, reason: 'stale-q1' });
    /* The receipt that caused it, with the original timestamp untouched: satisfied. */
    expect(decide({ status: 'resolved', entries: [{ ...DECIDED, decidedAfter: 'r-2' }] }, { reworkCutoff: cutoff }))
      .toEqual({ satisfied: true, reason: 'satisfied' });
    /* And with no rework at all the field is not demanded. */
    expect(decide({ status: 'resolved', entries: [DECIDED] }, { reworkCutoff: null }))
      .toEqual({ satisfied: true, reason: 'satisfied' });
  });

  it('refuses a decision attributed to a name the Change cannot attest', () => {
    /* The rule that keeps an Agent from signing its own answer: `decidedBy` has to name somebody
       this Change records — an approver on a receipt, or a Git author of the Change directory. */
    const result = decide({ status: 'resolved', entries: [{ ...DECIDED, decidedBy: 'nobody-here' }] }, { known: new Set(['alex']) });
    expect(result.satisfied).toBe(false);
    expect(result.reason).toMatch(/^undecided-1$/);
  });

  it('says which entries are undecided and why, beside the count', () => {
    /* `undecided-N` is matched by prefix elsewhere, so the count stays the block token and the
       sentence goes into the diagnostics. This is the half a reader acts on. */
    const diagnostics: Diagnostic[] = [];
    decide({ status: 'resolved', entries: [DECIDED, { id: 'q2', question: 'And this?' }] }, { diagnostics });
    const remedy = diagnostics.find((item) => item.code === 'XFORGE_CONDITION_LEDGER_UNDECIDED_REMEDY');
    expect(remedy?.message).toContain('"q2"');
    expect(remedy?.path).toBe(`${CHANGES}/add-feature/evidence/conditions/materialQuestions.yaml`);
  });

  it('treats a deliberately empty entry list as an assertion, not an oversight', () => {
    /* "This Change raised no material questions" is the same assertion `check-findings` accepts as
       `findings: []`. Refusing it stranded every Change that genuinely had nothing to clarify. */
    expect(decide({ status: 'resolved', entries: [] })).toEqual({ satisfied: true, reason: 'satisfied' });
  });

  it('keeps a missing ledger distinct from an unreadable one', () => {
    expect(decideStageCondition(CHANGES, 'add-feature', 'materialQuestions', 'resolved', {
      state: { id: 'add-feature', artifacts: [] } as unknown as ChangeState,
      workPackages: { status: 'absent', state: null, diagnostics: [] },
      contentRevision: 'sha256:content',
      gates: [],
      identities: identities(),
      diagnostics: [],
      reworkCutoff: null,
      sources: sources(),
    })).toEqual({ satisfied: false, reason: 'ledger-missing-expected-resolved' });

    expect(decide('a string is not a mapping')).toEqual({ satisfied: false, reason: 'ledger-unreadable' });
  });

  it('refuses a ledger that answers a different condition', () => {
    expect(decide({ condition: 'somethingElse', status: 'resolved', entries: [DECIDED] }))
      .toEqual({ satisfied: false, reason: 'ledger-subject-mismatch' });
  });
});
