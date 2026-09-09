import type {
  ApprovalPolicy,
  ApprovalReceipt,
  ChangeConfig,
  ChangeState,
  Diagnostic,
  GateEvidence,
  GovernanceRevision,
  GovernanceState,
  ProjectContext,
  StageFlow,
  FlowStage,
} from '../../types.js';
import type { ChangeAuditFacts } from '../audit.js';
import type { KnownIdentities } from '../ledger-identity.js';
import type { WorkPackageResolution } from '../work-packages.js';
import type { ApprovalBinding } from './receipts.js';
import { approvalsForPolicy, type loadTransitionReceipts } from './receipts.js';
import { collectConditionSources, conditionReworkCutoff, decideStageCondition } from './conditions.js';
import { artifactSatisfied, structuredExit } from '../flow-query.js';
import { gateBlockReason } from '../control-plane.js';

/**
 * Whether each legal transition out of this Stage may be taken, and what is stopping the ones that
 * may not.
 *
 * This is the product's central judgement — most of what `blockedBy` can say, and therefore most of
 * what an Agent is ever told about why it cannot proceed, is decided in these ninety lines. Until
 * now it could not be exercised without a project tree, a Git worktree, and a walk to whichever
 * Stage the case needed, because the loop it lived in read Gate Evidence and condition ledgers as
 * it went.
 *
 * Nothing here touches disk. Everything it needs was read by `resolveControlPlane` first and
 * arrives as `TransitionInputs` — which is why `ProjectContext` can be in that object without
 * making this impure: by the time a project reaches here it is loaded data, and the two fields read
 * off it (`changesPath`, and the approval providers `providerKinds` looks up) are values rather
 * than handles.
 */

export interface TransitionInputs {
  project: ProjectContext;
  flow: StageFlow;
  changeId: string;
  config: ChangeConfig;
  state: ChangeState;
  workPackages: WorkPackageResolution;
  /** Where the Change stands, and the Stage that goes with it — `null` when the id is unknown. */
  currentStage: string;
  currentIndex: number;
  current: FlowStage | null;
  candidates: string[];
  transitions: Awaited<ReturnType<typeof loadTransitionReceipts>>;
  approvals: { receipts: ApprovalReceipt[] };
  identities: KnownIdentities;
  revision: GovernanceRevision;
  auditFacts: ChangeAuditFacts;
  /** Required declared Gates this project has never answered, computed once for two readers. */
  undeclaredGates: string[];
  stageGateIds: string[];
  stageGateEvidence: Map<string, GateEvidence | null>;
  conditionSources: Awaited<ReturnType<typeof collectConditionSources>>;
  binding: ApprovalBinding;
  /** Appended to, not replaced: the caller collects diagnostics from every stage of the resolve. */
  diagnostics: Diagnostic[];
}

/* Not exported: the caller destructures it and never names the type. The suite refuses a module
   that exports a symbol nothing outside it names. */
interface TransitionDecision {
  transitionRequirements: Map<string, TransitionRequirement>;
  readyTransitions: GovernanceState['readyTransitions'];
  pendingApprovals: GovernanceState['pendingApprovals'];
}

export interface TransitionRequirement {
  approvals: ApprovalReceipt[];
  gates: GateEvidence[];
  blockedBy: string[];
  /** Which policies gate this target, recorded rather than recomputed by callers. */
  approvalPolicies: string[];
}

function policyById(flow: StageFlow, id: string): ApprovalPolicy | null {
  return flow.governance?.approvalPolicies.find((policy) => policy.id === id) ?? null;
}

function providerKinds(project: ProjectContext, policy: ApprovalPolicy): Array<{ id?: string; type: 'local' | 'mcp' }> {
  return policy.providers.map((id) => {
    if (id === 'local') return { type: 'local' as const };
    return { id, type: project.manifest.approvals?.providers.find((item) => item.id === id)?.type ?? 'mcp' };
  });
}

function exitConditionExpectation(value: unknown, classification: unknown): string | null {
  if (typeof value === 'string') return value;
  const condition = value as { requiredWhen?: { anyImpact?: string[] }; expected: string };
  const impacts = condition.requiredWhen?.anyImpact ?? [];
  if (impacts.length === 0) return condition.expected;
  const declared = (classification ?? {}) as Record<string, unknown>;
  return impacts.some((impact) => declared[impact] === true) ? condition.expected : null;
}

export function decideTransitions(input: TransitionInputs): TransitionDecision {
  const {
    project, flow, changeId, config, state, workPackages, currentStage, currentIndex, current,
    candidates, transitions, approvals, identities, revision, auditFacts, undeclaredGates,
    stageGateIds, stageGateEvidence, conditionSources, binding, diagnostics,
  } = input;
  const transitionRequirements = new Map<string, TransitionRequirement>();
  const readyTransitions: GovernanceState['readyTransitions'] = [];
  const pendingApprovals: GovernanceState['pendingApprovals'] = [];

for (const target of candidates) {
  const blockedBy: string[] = [];
  const approvalEvidence: ApprovalReceipt[] = [];
  const gateEvidence: GateEvidence[] = [];
  /* Which policies gate *this* target, recorded rather than recomputed by callers. A rework target
     is governed by none, and `approve.ts` needs to know that before it writes a receipt nothing
     will ever count. */
  const approvalPolicies: string[] = [];
  const isRework = currentIndex >= 0 && target !== 'ready-to-archive' && flow.stages.findIndex((stage) => stage.id === target) <= currentIndex;
  /* Outside the `isRework` guard on purpose: a forked or broken receipt chain makes the Change's
     current Stage itself unreliable, so rework is no more decidable than forward progress. This
     is the targeted block that replaces the whole-Change error the chain check used to raise. */
  if (!transitions.chainValid) blockedBy.push('transition-chain:invalid');
  if (!isRework && current) {
    /*
     * Only on the first transition, and deliberately not on every one.
     *
     * Repeating it at each Stage would be a second way of saying what the Gate itself says when
     * the Change reaches the Stage that runs it, and it would block a Change that is already
     * under way for a project-level answer that was not missing when it started. Once is enough:
     * a Change that got past propose either found the answer recorded or was told to record it.
     */
    if (transitions.receipts.length === 0) {
      for (const gateId of undeclaredGates) blockedBy.push(`verification:${gateId}:undeclared`);
    }
    for (const artifactId of current.produces) {
      if (!artifactSatisfied(state.artifacts.find((artifact) => artifact.id === artifactId)?.status)) blockedBy.push(`artifact:${artifactId}`);
    }
    /* `unusable` blocks rather than falls through to the plan-less path: a plan nobody can read
       cannot show that its packages were delivered, and treating it as "no plan" would let the
       implementing Stage close on a file that does not parse. */
    if (current.id === 'apply' && target === 'verify' && workPackages.status === 'unusable') blockedBy.push('work-packages:unusable');
    if (current.id === 'apply' && target === 'verify' && state.workPackages) {
      for (const workPackage of state.workPackages.packages) if (!['succeeded', 'integrated', 'reviewed'].includes(workPackage.status)) blockedBy.push(`work-package:${workPackage.id}:${workPackage.status}`);
      /* Kept distinct from the package blocks above on purpose. `work-package:<id>:failed` says
         "that package's delivery is bad"; this says "the tree holds work no package claims". The
         two have entirely different repairs, and reporting the second in the shape of the first
         sent a live run looking for defects in three deliveries that had none. */
      if (state.workPackages.unattributedPaths?.length) blockedBy.push('tree:unattributed-paths');
    }
    const exit = structuredExit(current);
    for (const gateId of stageGateIds) {
      const evidence = stageGateEvidence.get(gateId) ?? null;
      /* Gate Evidence is bound to content, not to Stage/transition state or to gitHead. */
      const reason = gateBlockReason(evidence, revision.contentRevision);
      if (reason) blockedBy.push(`gate:${gateId}:${reason}`);
      else gateEvidence.push(evidence!);
    }
    /* Conditions are evaluated after the Gates, not before: the verification-receipt ledger is
       decided against the Gate Evidence this Stage actually produced, so that set has to exist. */
    for (const [key, declared] of Object.entries(exit.conditions ?? {})) {
      const expected = exitConditionExpectation(declared, config.classification);
      if (expected === null) continue;
      const condition = decideStageCondition(project.changesPath, changeId, key, expected, {
        state, workPackages, contentRevision: revision.contentRevision, gates: gateEvidence, identities, diagnostics,
        reworkCutoff: conditionReworkCutoff(flow, transitions.receipts, current.id),
        sources: conditionSources,
      });
      if (!condition.satisfied) blockedBy.push(`condition:${key}:${condition.reason}`);
    }
    for (const policyId of exit.approvals ?? []) {
      approvalPolicies.push(policyId);
      const policy = policyById(flow, policyId);
      if (!policy) { blockedBy.push(`approval-policy:${policyId}:missing`); continue; }
      const result = approvalsForPolicy(approvals.receipts, policy, target, binding);
      approvalEvidence.push(...result.valid);
      if (result.rejected) blockedBy.push(`approval:${policyId}:rejected`);
      if (!result.separationSatisfied) blockedBy.push(`approval:${policyId}:separation-of-duties`);
      if (result.missing > 0) {
        blockedBy.push(`approval:${policyId}:missing-${result.missing}`);
      }
      if (result.missing > 0 || !result.separationSatisfied) {
        pendingApprovals.push({ policyId, transition: target, missing: result.missing, roles: policy.roles, providers: providerKinds(project, policy) });
      }
    }
    for (const eventType of exit.auditEvents ?? []) if (!auditFacts.eventTypes.includes(eventType)) blockedBy.push(`audit:${eventType}:missing`);
    if (!auditFacts.chain.valid) blockedBy.push('audit:chain-invalid');
  }
  transitionRequirements.set(target, { approvals: approvalEvidence, gates: gateEvidence, blockedBy, approvalPolicies });
  readyTransitions.push({
    to: target,
    ready: blockedBy.length === 0,
    blockedBy,
    command: ['xforge', 'transition', '--change', changeId, '--to', target],
  });
}

if (currentStage === 'ready-to-archive') {
  for (const policyId of flow.terminal.archive.approvals ?? []) {
    const policy = policyById(flow, policyId);
    if (!policy) continue;
    const result = approvalsForPolicy(approvals.receipts, policy, 'archive', binding);
    if (result.missing > 0 || result.rejected || !result.separationSatisfied) pendingApprovals.push({ policyId, transition: 'archive', missing: result.missing, roles: policy.roles, providers: providerKinds(project, policy) });
  }
}
  return { transitionRequirements, readyTransitions, pendingApprovals };
}
