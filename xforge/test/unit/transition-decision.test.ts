/*
 * @red-first coverage-only: pins behaviour that was already there. It goes red against the parent because `decideTransitions` does not exist yet, which is the false green the test architecture describes — not evidence that it discriminates a fix.
 */
import { describe, expect, it } from 'vitest';
import { decideTransitions, type TransitionInputs } from '../../src/core/control-plane/transitions.js';
import type { GateEvidence } from '../../src/types.js';

/**
 * Whether a Stage may be left, decided without a project on disk.
 *
 * This is the product's central judgement: most of what `blockedBy` can say — and therefore most of
 * what an Agent is ever told about why it cannot proceed — comes out of the function under test.
 * Reaching it used to mean a real project tree, a real Git worktree, and a walk to whichever Stage
 * carried the case. The rules are the intricate part; the walk was the expensive part.
 *
 * Every case below is one an integration test could reach only by arranging the whole world first.
 */

const REVISION = 'sha256:content';

function passing(gate: string): GateEvidence {
  return { gate, status: 'passed', contentRevision: REVISION } as unknown as GateEvidence;
}

/** A Stage with one legal target, one Gate, and nothing else declared. */
function inputs(overrides: Partial<TransitionInputs> = {}): TransitionInputs {
  const current = { id: 'verify', produces: [], gates: ['unit-tests'], exit: {} };
  return {
    project: { changesPath: 'xforge/changes', manifest: { approvals: { providers: [] } } },
    flow: { stages: [{ id: 'apply' }, current], governance: { approvalPolicies: [] }, terminal: { archive: {} } },
    changeId: 'add-feature',
    config: { classification: {} },
    state: { id: 'add-feature', artifacts: [], workPackages: null },
    workPackages: { status: 'absent', state: null, diagnostics: [] },
    currentStage: 'verify',
    currentIndex: 1,
    current,
    candidates: ['ready-to-archive'],
    transitions: { receipts: [{ sequence: 1 }], chainValid: true, diagnostics: [] },
    approvals: { receipts: [] },
    identities: { values: new Set(), empty: true, actors: new Set(), fallback: new Set(), managed: false },
    revision: { contentRevision: REVISION, stateRevision: 'sha256:state', governingRevision: 'sha256:governing' },
    auditFacts: { eventTypes: [], chain: { valid: true } },
    undeclaredGates: [],
    stageGateIds: ['unit-tests'],
    stageGateEvidence: new Map([['unit-tests', passing('unit-tests')]]),
    conditionSources: { ledgers: new Map(), receipt: { kind: 'unusable', relative: '', reason: 'receipt-missing', problems: [] }, reviews: { receipts: [], diagnostics: [] } },
    binding: { governingRevision: 'sha256:governing', stateRevision: 'sha256:state' },
    diagnostics: [],
    ...overrides,
  } as unknown as TransitionInputs;
}

const blocks = (overrides: Partial<TransitionInputs> = {}): string[] =>
  decideTransitions(inputs(overrides)).readyTransitions[0]!.blockedBy;

describe('transition decision', () => {
  it('lets a Stage close when its Gate passed against the current content', () => {
    const decision = decideTransitions(inputs());
    expect(decision.readyTransitions).toEqual([{
      to: 'ready-to-archive',
      ready: true,
      blockedBy: [],
      command: ['xforge', 'transition', '--change', 'add-feature', '--to', 'ready-to-archive'],
    }]);
    /* The accepted Evidence travels with the requirement, because the Transition receipt records
       which Gate results it was taken on. */
    expect(decision.transitionRequirements.get('ready-to-archive')?.gates.map((gate) => gate.gate)).toEqual(['unit-tests']);
  });

  it('separates a Gate that never ran from one that failed from one that went stale', () => {
    /*
     * The three have entirely different repairs — run it, fix the finding, re-run it — and they are
     * the block an Agent meets most often. Gate Evidence binds to content, so an Agent that runs one
     * Gate, edits an Artifact, then runs the next has invalidated the first while every Gate still
     * reports `passed`.
     */
    expect(blocks({ stageGateEvidence: new Map([['unit-tests', null]]) })).toEqual(['gate:unit-tests:missing']);
    expect(blocks({ stageGateEvidence: new Map([['unit-tests', { ...passing('unit-tests'), status: 'failed' } as GateEvidence]]) }))
      .toEqual(['gate:unit-tests:failed']);
    expect(blocks({ stageGateEvidence: new Map([['unit-tests', { ...passing('unit-tests'), contentRevision: 'sha256:older' } as GateEvidence]]) }))
      .toEqual(['gate:unit-tests:stale']);
  });

  it('blocks every target while the receipt chain is forked, rework included', () => {
    /*
     * Outside the rework guard on purpose: a broken chain makes the Change's current Stage itself
     * unreliable, so going backwards is no more decidable than going forwards. This is the targeted
     * block that replaced a whole-Change error.
     */
    const decision = decideTransitions(inputs({
      transitions: { receipts: [{ sequence: 1 }], chainValid: false, diagnostics: [] } as unknown as TransitionInputs['transitions'],
      candidates: ['apply'],
    }));
    expect(decision.readyTransitions[0]!.blockedBy).toContain('transition-chain:invalid');
  });

  it('names an Artifact the Stage owes before it can be left', () => {
    expect(blocks({
      current: { id: 'verify', produces: ['verification-report'], gates: [], exit: {} } as unknown as TransitionInputs['current'],
      stageGateIds: [],
      stageGateEvidence: new Map(),
    })).toEqual(['artifact:verification-report']);
  });

  it('asks for an undeclared Gate only on the Change\'s first transition', () => {
    /*
     * Once, not at every Stage. Repeating it would block a Change already under way for a
     * project-level answer that was not missing when it started, and the Gate itself says the same
     * thing when the Change reaches the Stage that runs it.
     */
    const firstMove = { transitions: { receipts: [], chainValid: true, diagnostics: [] } } as unknown as Partial<TransitionInputs>;
    expect(blocks({ ...firstMove, undeclaredGates: ['module-boundaries'] })).toContain('verification:module-boundaries:undeclared');
    expect(blocks({ undeclaredGates: ['module-boundaries'] })).not.toContain('verification:module-boundaries:undeclared');
  });

  it('reports a missing approval as pending, with the roles that can give it', () => {
    const decision = decideTransitions(inputs({
      current: { id: 'verify', produces: [], gates: [], exit: { approvals: ['release'] } } as unknown as TransitionInputs['current'],
      stageGateIds: [],
      stageGateEvidence: new Map(),
      flow: {
        stages: [{ id: 'apply' }, { id: 'verify' }],
        governance: { approvalPolicies: [{ id: 'release', minApprovers: 1, roles: ['owner'], providers: ['local'] }] },
        terminal: { archive: {} },
      } as unknown as TransitionInputs['flow'],
    }));
    expect(decision.readyTransitions[0]!.blockedBy).toEqual(['approval:release:missing-1']);
    expect(decision.pendingApprovals).toEqual([{
      policyId: 'release', transition: 'ready-to-archive', missing: 1, roles: ['owner'], providers: [{ type: 'local' }],
    }]);
  });
});
