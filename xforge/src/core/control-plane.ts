import { readFile } from 'node:fs/promises';
import type {
  ApprovalPolicy,
  ChangeConfig,
  ChangeState,
  Diagnostic,
  GateEvidence,
  GovernanceState,
  ProjectContext,
  StageFlow,
  ExitCondition,
} from '../types.js';
import { diagnostic } from './errors.js';
import { normalizeRule, policyApplies, resolveRuleEnforcement, ruleApplies } from './governance.js';
import { sha256, stableStringify } from './hash.js';
import { safeResolve } from './path-safety.js';
import type { SelectedResources } from './resource-loader.js';
import { changeImplementers, computeGovernanceRevision } from './revision.js';
import { readChangeAuditEvents, remoteDeliveryRequired, type ChangeAuditFacts } from './audit.js';
import { knownIdentities } from './ledger-identity.js';
import { flowArchiveOperation } from './flow-resolver.js';
import { currentStageOf, stageGates, structuredExit } from './flow-query.js';
import { undeclaredRequiredGates, verificationDeclareArgv } from './verification.js';
import { resolveWorkPackages, type WorkPackageResolution } from './work-packages.js';
import { exists } from './files.js';
import {
  approvalsForPolicy, boundToRevision, loadApprovalReceipts, loadTransitionReceipts, type ApprovalBinding,
} from './control-plane/receipts.js';
import { collectConditionSources, conditionReworkCutoff, decideStageCondition } from './control-plane/conditions.js';
import { decideTransitions, type TransitionRequirement } from './control-plane/transitions.js';
import { legalTransitionTargets } from './control-plane/graph.js';

/*
 * Forwarded rather than moved-and-rewired at every call site. `checker.ts` and `constitution-check.ts`
 * ask the control plane for these, which is the right question for them to ask — the split below is
 * about how this module is built, not about who it answers to.
 */
export { INDEPENDENT_REVIEW_CONDITION, declaresIndependentReview, independentReviewObligations, reachedImplementationStage, unreviewedDeliveredPackages } from './control-plane/conditions.js';
import { independentReviewObligations } from './control-plane/conditions.js';
export { loadApprovalReceipts, loadTransitionReceipts } from './control-plane/receipts.js';
export { legalTransitionTargets } from './control-plane/graph.js';


/**
 * One Gate's Evidence, or null when it is absent, unparseable, or not the Evidence it claims to be.
 *
 * Exported because reconciliation has to answer "did this Gate pass" from the same bytes the control plane
 * does. It used to answer from `transitionRequirements`, which is a different question -- see the
 * note on `gatePassed` in `core/reconcile.ts`.
 */
export async function readGateEvidence(project: ProjectContext, changeId: string, gateId: string, resources: SelectedResources): Promise<GateEvidence | null> {
  const gate = resources.gates.get(gateId)?.value;
  if (!gate) return null;
  const evidencePath = `${project.changesPath}/${changeId}/evidence/${gate.spec.evidence}`;
  const absolute = await safeResolve(project.root, evidencePath);
  if (!await exists(absolute)) return null;
  try {
    const evidence = JSON.parse(await readFile(absolute, 'utf8')) as GateEvidence;
    const { digest, ...unsigned } = evidence;
    return digest === sha256(stableStringify(unsigned)) && evidence.gate === gateId && evidence.change === changeId ? evidence : null;
  } catch { return null; }
}

function policyById(flow: StageFlow, id: string): ApprovalPolicy | null {
  return flow.governance?.approvalPolicies.find((policy) => policy.id === id) ?? null;
}

/**
 * The ways this policy can be satisfied, as `state` reports them.
 *
 * Local approval carries no `id`, and the omission is the point. `--provider` names an MCP provider
 * declared under `manifest.approvals.providers`; terminal approval is what happens when the flag is
 * absent, and there is no id to pass. Reporting `{"id": "local", "type": "local"}` put a plausible
 * argument in front of a reader who then ran `xforge approve --provider local` and was told the
 * provider "is not authorized" — an accurate sentence about a name this command had handed them.
 */
export interface ResolvedControlPlane {
  governance: GovernanceState;
  diagnostics: Diagnostic[];
  flow: StageFlow;
  /** The Change state this resolve decided against, with its work-package plan filled in. */
  state: ChangeState;
  /** The plan as resolved here, including why there is none. Every consumer reads this one. */
  workPackages: WorkPackageResolution;
  transitionRequirements: Map<string, TransitionRequirement>;
  resources: SelectedResources;
  /** Audit facts for this Change as of this resolution, usable without the local `.audit` chain. */
  auditFacts: ChangeAuditFacts;
  /**
   * False when the Transition receipts on disk do not form one unbroken chain.
   *
   * Carried here rather than left to `control.diagnostics.some(...)` because it decides a block, not
   * a message: every candidate transition and archive is refused while it is false, and both of
   * those refusals must agree with the diagnostic that explains them.
   */
  transitionChainValid: boolean;
}

/**
 * The whole control plane for one Change: what it may do next, and what stops it.
 *
 * The work-package plan is resolved *here* rather than assigned onto `state` by each caller, and
 * that is a correctness property, not a tidiness one. Six call sites remembered to assign it and
 * two did not — `archive` and the post-transition re-resolve — and because an unassigned plan is
 * indistinguishable from an absent one, neither failed loudly: archive silently re-decided
 * `independentReview` against an empty package list and refused every Major Change that used a
 * plan, with a remedy (`xforge review acknowledge`) that refuses while a plan file exists. A caller
 * that has already resolved passes its resolution in to avoid the second read; a caller that has
 * not gets a correct one instead of an empty one.
 */
/**
 * What a Stage's declared exit condition asks of *this* Change, or null when it asks nothing.
 *
 * A condition used to be a bare string and every Change on the Flow owed it. The object form
 * narrows the population by the Change's own `classification`, in the same shape the Artifacts use:
 * `contractDecisions` records who decided a breaking interface change, and a Change that declares
 * no interface change has no such decision to record. Requiring the ledger anyway would have meant
 * every Change on the Flow filing `entries: []` -- a turn spent asserting nothing, with the Stage
 * held open until it was spent.
 *
 * Self-declared, and the CLI does not imply otherwise: a Change that moves an interface while
 * declaring it did not skips this the same way it skips the delta. `contract-compat` is what
 * compares the declaration with what moved, and it is dialect-specific, so it is selected.
 */
function exitConditionExpectation(value: ExitCondition, classification: unknown): string | null {
  if (typeof value === 'string') return value;
  const impacts = value.requiredWhen?.anyImpact ?? [];
  if (impacts.length === 0) return value.expected;
  const declared = (classification ?? {}) as Record<string, unknown>;
  return impacts.some((impact) => declared[impact] === true) ? value.expected : null;
}

/**
 * When an undeclared Gate actually bites, said per Gate rather than asserted once.
 *
 * This sentence used to read "which on this Flow is after an approval has been collected" in a
 * message that names the Flow in its first clause — and it is false for most of them. Quick runs
 * `unit-tests` at verify and collects its only approval at archive, after it; a contract-governed
 * Flow runs `contract-lint` at design, two Stages before `planning-solid`. Two separate live runs
 * met the wrong half of it. A reader who checks a claim like this once and finds it untrue stops
 * checking the rest of the message, which is where the part that matters is.
 */
function whenItBites(flow: StageFlow, gateId: string): string {
  const index = flow.stages.findIndex((stage) => stageGates(stage).includes(gateId));
  if (index < 0) return 'which on this Flow is the archive it is mandatory for';
  const stage = flow.stages[index]!;
  const approvalBefore = flow.stages
    .slice(0, index)
    .some((earlier) => (earlier.exit?.approvals ?? []).length > 0);
  return approvalBefore
    ? `which on this Flow is the ${stage.id} Stage, after an approval has already been collected`
    : `which on this Flow is the ${stage.id} Stage, before any approval is collected`;
}

export async function resolveControlPlane(
  project: ProjectContext,
  changeId: string,
  /*
   * The Change as `resolveChangeState` returned it, rather than its three fields passed one at a
   * time.
   *
   * Four of this function's six positional parameters always came from the same object, re-typed at
   * fifteen call sites -- `resolved.flow, resolved.state, resources, resolved.config` -- which is a
   * quadruple nothing checked the order of. `resolved.state` where `resolved.flow` was meant
   * compiles; so does a `config` from one Change beside a `flow` from another. Taking the object
   * makes both unspellable.
   */
  resolved: { flow: StageFlow; state: ChangeState; config: ChangeConfig },
  resources: SelectedResources,
  options: { workPackages?: WorkPackageResolution; projectFacts?: boolean } = {},
): Promise<ResolvedControlPlane> {
  const { flow, state: changeState, config } = resolved;
  const diagnostics: Diagnostic[] = [];
  const workPackages = options.workPackages ?? await resolveWorkPackages(project, changeId, config, resources);
  /* Not a mutation of the caller's object: `control.state` is what every consumer of this resolve
     reads, including `terminalGovernanceBlocks`, and it must carry the plan whether or not the
     caller had one to give. */
  const state: ChangeState = { ...changeState, workPackages: workPackages.state };
  const transitions = await loadTransitionReceipts(project, changeId, flow);
  const approvals = await loadApprovalReceipts(project, changeId);
  /* Identities the repository actually records, so a ledger can cite a decision-maker but not
     invent one. Computed once per resolve and shared by every condition ledger. */
  const identities = await knownIdentities(project, changeId, approvals.receipts);
  diagnostics.push(...transitions.diagnostics, ...approvals.diagnostics);
  /* `unknown` because this value goes into receipt-shaped fields that must carry a string; the
     portfolio listing applies `null` to the same derivation. */
  const currentStage = currentStageOf(flow, transitions.receipts) ?? 'unknown';
  const transitionHead = transitions.receipts.at(-1)?.digest ?? null;
  const revision = await computeGovernanceRevision(project, changeId, flow, state, resources, currentStage, transitionHead);
  /*
   * One read of the Change's audit facts, which resolve from the committed
   * `evidence/audit/index.json` when the gitignored local chain is absent (fresh clone, CI).
   */
  const auditFacts = await readChangeAuditEvents(project, changeId);
  const currentIndex = flow.stages.findIndex((stage) => stage.id === currentStage);
  const current = currentIndex >= 0 ? flow.stages[currentIndex]! : null;
  const candidates = current ? legalTransitionTargets(flow, current.id) : [];
  /*
   * The required declared Gates this project has never answered, computed once for two readers.
   *
   * The diagnostic below has reported them since propose, with the exact `verification declare`
   * command already substituted, and a measured `solid` run met it at propose and carried it
   * unanswered to verify. Information was not what was missing. What follows is the same fact used
   * as a block, on the Change's first transition only: the question is answerable before any Change
   * exists, it is going to refuse a Stage either way, and the only choice is whether it refuses
   * where nothing has been spent or after four Stages and a human approval have.
   */
  const undeclaredGates = undeclaredRequiredGates(project, resources.gates, [
    ...flow.stages.flatMap(stageGates),
    ...flowArchiveOperation(flow).mandatoryGates,
  ]);
  /*
   * The Stage's Gate Evidence and condition sources, read once for every candidate rather than once
   * per candidate.
   *
   * Both reads are loop-invariant and were not written as such: neither `readGateEvidence` nor the
   * condition sources take the target, so a Stage with three legal targets opened the same files
   * three times. Hoisting them is what makes the judgement below a pure function of what was read —
   * `decideStageCondition` no longer touches disk — and the duplicate reads go with it.
   *
   * Skipped entirely when no candidate can use them, which is the rework-only case the guard below
   * already expressed: reading a Stage's Evidence to decide a transition that ignores it would be
   * work this never did.
   */
  const anyForward = current !== null && candidates.some((target) =>
    !(currentIndex >= 0 && target !== 'ready-to-archive' && flow.stages.findIndex((stage) => stage.id === target) <= currentIndex));
  const stageGateIds = current && anyForward ? stageGates(current) : [];
  const stageGateEvidence = new Map<string, GateEvidence | null>(
    await Promise.all(stageGateIds.map(async (gateId) => [gateId, await readGateEvidence(project, changeId, gateId, resources)] as const)),
  );
  const conditionKeys = current && anyForward ? Object.keys(structuredExit(current).conditions ?? {}) : [];
  const conditionSources = await collectConditionSources(project, changeId, conditionKeys);

  /*
   * Separation of duties needs Git history, and it is read here rather than behind a lazy thunk.
   *
   * The laziness was a cost guard and the guard is kept, just moved to where it can be answered
   * before anything is decided: the policies this resolve can possibly consult are the current
   * Stage's exit approvals and, at `ready-to-archive`, the terminal ones — both named by the Flow,
   * neither depending on the target. So "will any policy that is actually reached ask for
   * separation of duties" is answerable up front, and answering it up front is what leaves the
   * decision below with no I/O in it at all.
   */
  const consultedPolicies = [
    ...(current && anyForward ? structuredExit(current).approvals ?? [] : []),
    ...(currentStage === 'ready-to-archive' ? flow.terminal.archive.approvals ?? [] : []),
  ];
  const needsImplementers = consultedPolicies.some((id) => policyById(flow, id)?.separationOfDuties);
  const implementers = needsImplementers ? await changeImplementers(project, changeId, state) : null;
  const binding: ApprovalBinding = {
    governingRevision: revision.governingRevision!,
    stateRevision: revision.stateRevision,
    implementers: implementers ?? undefined,
  };

  const { transitionRequirements, readyTransitions, pendingApprovals } = decideTransitions({
    project, flow, changeId, config, state, workPackages, currentStage, currentIndex, current,
    candidates, transitions, approvals, identities, revision, auditFacts, undeclaredGates,
    stageGateIds, stageGateEvidence, conditionSources, binding, diagnostics,
  });

  /*
   * A Rule's enforcement refs are resolved against what this Flow and this project actually contain,
   * not merely counted.
   *
   * The Scaffold's `design-decisions-need-a-human` declared `approvalRefs: [planning-solid]`, a
   * policy that exists only in the `solid` Flow. Under `major` the counting version reported the
   * Rule as having enforcement — `approvalRefs` was non-empty, so the `uncovered` branch never fired
   * — while nothing whatsoever checked it: no receipt could ever carry that policy id, so `approved`
   * could never be added either. The Rule read as governed precisely because it named a mechanism
   * that was absent. A citation that resolves to nothing is the one case a coverage report must not
   * treat as coverage.
   */
  const flowPolicyIds = new Set((flow.governance?.approvalPolicies ?? []).map((policy: ApprovalPolicy) => policy.id));
  /*
   * The validators this Flow actually runs, which is what makes a `validatorRefs` claim resolvable.
   *
   * Named off the Flow's own Artifacts rather than off the enum in the schema: `contract-delta` is
   * implemented by the CLI on every project, and on a Flow that declares no Artifact carrying that
   * validator it never runs — so a Rule citing it there is in exactly the position a Rule citing an
   * absent Gate is, and has to report the same way. Deciding this from the enum would reintroduce
   * the defect the `enforceableRefs` split was written to close, one field over.
   */
  const flowValidators = new Set((flow.artifacts ?? [])
    .map((artifact: { validator?: string }) => artifact.validator)
    .filter((validator): validator is string => Boolean(validator)));
  const rules = [...resources.rules.values()].map((item) => normalizeRule(item.value)).filter((rule) => ruleApplies(rule, config, currentStage)).map((rule) => {
    const enforcement = resolveRuleEnforcement(rule, {
      gates: new Set(resources.gates.keys()),
      policies: new Set(resources.policies.keys()),
      flowApprovalPolicies: flowPolicyIds,
      flowValidators,
    });
    const coverage: GovernanceState['rules'][number]['coverage'] = ['instructed'];
    if (enforcement.resolvedPolicies.length > 0) coverage.push('guarded');
    /* In-process and unconditional: unlike a Gate, there is no Stage at which this has not run yet,
       because the validator refuses the document at the moment anything reads it. */
    const resolvedValidators = rule.validatorRefs.filter((id) => flowValidators.has(id));
    if (resolvedValidators.length > 0) coverage.push('structural');
    const verified = rule.gateRefs.some((id) => transitionRequirements.get(candidates[0] ?? '')?.gates.some((gate) => gate.gate === id));
    if (verified) coverage.push('verified');
    const approved = rule.approvalRefs.some((id) => approvals.receipts.some((receipt) => receipt.policyId === id && receipt.decision === 'approve'
      && boundToRevision(receipt, { governingRevision: revision.governingRevision!, stateRevision: revision.stateRevision })));
    if (approved) coverage.push('approved');
    const { enforceableRefs } = enforcement;
    if (rule.severity === 'must' && enforcement.claimsNothing) coverage.push('uncovered');
    else if (enforcement.unenforceable) coverage.push('unenforceable');
    return { id: rule.id, severity: rule.severity, instruction: rule.instruction, coverage, gateRefs: rule.gateRefs, policyRefs: rule.policyRefs, approvalRefs: rule.approvalRefs, validatorRefs: rule.validatorRefs, enforceableRefs };
  });
  /*
   * A `must` Rule this Change never sees, said out loud once.
   *
   * `ruleApplies` compares a Rule's `scope.paths` against the paths this Change declares in its own
   * `change.yaml` — not against the repository — and a Rule that matches none of them is absent
   * from `governance.rules`, which is how a Rule reaches the Agent at all. It is not weakened, not
   * downgraded, not reported: it is simply not there, and the Change proceeds as though it had
   * never been written. A live monorepo run finished a Major Change with `governance.rules: []`
   * while `observable-requirements-are-tested` (severity `must`) sat selected in the Manifest, its
   * shipped `src/**` scope matching nothing in a repository whose code is under `apps/` and
   * `packages/`. `doctor` reported nothing wrong, correctly — the Rule is registered and its
   * enforcement resolves; only its reach was empty.
   *
   * One `info` for the whole set, because non-application is often right: a docs-only Change should
   * not be told about a testing Rule. What was missing was any way to notice when it is wrong.
   */
  /*
   * Reported where somebody asks what the situation is, and not on every call.
   *
   * This is a fact about the project's configuration, identical on every invocation for a given
   * Change -- and it was emitted by all of them. A live run counted it more than twenty times in one
   * scenario and said it "trains an agent to skim diagnostics", which is the opposite of what the
   * diagnostics next to it need. `state` is where a reader asks what is going on; `check` asks
   * whether something passed and `transition` whether it may move, and neither question is answered
   * by this.
   *
   * Kept on the call path rather than moved to `doctor`, which was the other candidate: the defect
   * this exists to catch is that nobody noticed a Rule had gone silent, and a command people run
   * rarely is where not noticing happens.
   */
  const outOfScope = options.projectFacts
    ? [...resources.rules.values()]
      .map((item) => normalizeRule(item.value))
      .filter((rule) => rule.severity === 'must' && rule.paths.length > 0 && !ruleApplies(rule, config, currentStage))
    : [];
  if (outOfScope.length > 0) {
    diagnostics.push(diagnostic(
      'XFORGE_RULE_OUT_OF_CHANGE_SCOPE',
      `${outOfScope.length} severity-must Rule(s) do not reach this Change: ${outOfScope.map((rule) => rule.id).join(', ')}. A Rule's scope.paths is compared with the paths change.yaml declares, never with the repository. \`xforge doctor\` lists each scope.`,
      `${project.changesPath}/${changeId}/change.yaml`,
      'info',
    ));
  }
  for (const rule of rules) {
    if (!rule.coverage.includes('unenforceable')) continue;
    diagnostics.push(diagnostic(
      'XFORGE_RULE_ENFORCEMENT_UNAVAILABLE',
      `Rule ${rule.id} is severity must and its enforcement cites ${[...rule.gateRefs, ...rule.policyRefs, ...rule.approvalRefs, ...rule.validatorRefs].join(', ')}, none of which exists under Flow ${flow.metadata.name}: the Rule is instruction only here. Either declare enforcement this Flow can apply, or word the Rule so it does not promise a mechanism that depends on which Flow a Change happens to run.`,
      [...resources.rules.values()].find((item) => item.value.metadata.name === rule.id)?.yamlPath ?? 'xforge/scaffold/rules',
      'warning',
    ));
  }

  /*
   * A required declared Gate nobody has answered, said here rather than only in `doctor`.
   *
   * The condition was already detected — `commands/doctor.ts` finds it and names the exact declare
   * command — but only a reader who thinks to run `doctor` ever sees it, and an agent-driven session
   * has no reason to. A field report watched a Major Flow's Gate fail on the archive path, after a
   * human approval had already been spent, for a question answerable before the first Change
   * existed. `state` is what every Skill polls, so this is where it becomes unmissable.
   *
   * `info`, not `warning`. The severity is not what was missing — visibility was — and `check`
   * counts warnings when deciding whether a Stage may close, so raising this one would make an
   * unanswered question block Stages it has no business blocking. It is also self-clearing: one
   * `verification declare` and it is gone for good.
   *
   * Visibility turned out not to be enough either — a measured `solid` run met this at propose and
   * carried it, unanswered, to verify — so the same set now also blocks the Change's first
   * transition (`verification:<gate>:undeclared`, above). This stays as it is: the severity
   * argument above is unchanged, and a Change already past its first transition still meets this
   * notice and no block. What the two say together is "not answered yet", once at the moment it
   * can still be answered for free, and thereafter as a standing report.
   */
  for (const gateId of undeclaredGates) {
    diagnostics.push({
      ...diagnostic(
        'XFORGE_VERIFICATION_GATE_UNDECLARED',
        `Flow ${flow.metadata.name} requires Gate ${gateId}, which runs whatever this project declares under manifest.verification.${gateId} — currently nothing. A Change that has not taken a transition yet is refused now, at its first one; one already under way keeps going and meets the Gate itself when it reaches the Stage that runs it, ${whenItBites(flow, gateId)}. Answer it now with \`xforge verification declare --gate-name ${gateId} --command '["cargo","test"]' --by <person>\`, substituting the command this project actually verifies itself with. Do not answer it with whatever command happens to exist: a test command on a repository with no tests passes this Gate while asserting nothing.`,
        'xforge/manifest.yaml',
        'info',
      ),
      /*
       * The same command the message has always named, in the field a reader can act on.
       *
       * This one is determinate -- gate id and subcommand are both known here -- and it is the shape
       * `remedy` was added for: the message says *why*, which no argv carries, and the argv says
       * *what to run*, which no reader should have to parse back out of a sentence. A measured
       * `solid` run met this diagnostic at propose and carried it, unanswered, to verify.
       *
       * `<program>` stays a placeholder where the message shows `["cargo","test"]`. The message can
       * afford an illustration because the sentence after it says not to copy one; a field that
       * exists to be executed cannot, and this Gate is here precisely because a plausible-looking
       * test command that asserts nothing is the failure being prevented.
       */
      remedy: { commands: [verificationDeclareArgv(gateId)] },
    });
  }

  /*
   * The route out of a blocked transition, said where the block is read and not only where it is hit.
   *
   * `blockRemedy` is called from `transition` and `archive` -- you get the remedy when you try the
   * thing. But `XFORGE.md` tells an Agent to treat `state` as the authoritative account of what to
   * do next, and `state` carried the block as a bare token: `condition:materialQuestions:stale-Q1`
   * and nothing else. `xforge explain` does not take it either, because it is not a diagnostic code.
   *
   * A live run met exactly that and said so: the message alone was not enough to work out what had
   * gone stale or why, and it only knew that re-dating the entry is forbidden because the Skill
   * carries a bullet about it. Its own words -- someone working from CLI output alone "would very
   * plausibly have bumped the timestamp", which is the one move the field exists to prevent. The
   * same run met XFORGE_GATE_EVIDENCE_STALE, which names the Gate, the binding and the exact
   * command, and called that one sufficient without the Skill. Same mechanism, two ledgers, and the
   * difference was entirely in what the CLI said.
   *
   * Deduplicated by code: several transitions are usually blocked by the same thing, and repeating
   * one remedy per target is how a reader learns to skip the section.
   */
  const remedied = new Set<string>();
  for (const transition of readyTransitions) {
    if (transition.blockedBy.length === 0) continue;
    const remedy = blockRemedy(transition.blockedBy, changeId, {
      reworkReceiptId: conditionReworkCutoff(flow, transitions.receipts, currentStage)?.receiptId ?? null,
    });
    if (!remedy || remedied.has(remedy.code)) continue;
    remedied.add(remedy.code);
    const entry = diagnostic(remedy.code, remedy.message, `${project.changesPath}/${changeId}`, 'info');
    diagnostics.push(remedy.remedy ? { ...entry, remedy: remedy.remedy } : entry);
  }

  /*
   * What is owed but not yet refusing anything, computed once and put where a reader will find it.
   *
   * `blockedBy` can only ever carry conditions on transitions out of the *current* Stage, so a
   * condition declared on Verify's exit is invisible from Apply -- the one Stage that can still
   * satisfy it. The obligation is written onto the packages themselves and onto `willBlock`,
   * because a narrowed reply (`--field work.packages`, `--field blockedBy`) prints one value and
   * no diagnostics at all, and those two fields are what a measured Apply Agent asked for by name.
   */
  const obligations = independentReviewObligations(resolved.flow, workPackages.state, currentStage);
  for (const item of workPackages.state?.packages ?? []) item.owes = obligations.owes.get(item.id) ?? [];

  const governance: GovernanceState = {
    currentStage, transitionHead, transitions: transitions.receipts, revision,
    willBlock: obligations.willBlock,
    pendingApprovals: pendingApprovals.filter((item, index, all) => index === all.findIndex((candidate) => candidate.policyId === item.policyId && candidate.transition === item.transition)),
    approvals: approvals.receipts,
    rules,
    policies: [...resources.policies.values()].map((item) => ({ id: item.value.metadata.name, capability: item.value.spec.capability, effect: item.value.spec.effect, applicable: policyApplies(item.value, config, currentStage) })),
    hooks: [...resources.hooks.values()].map((item) => ({ id: item.value.metadata.name, plane: item.value.spec.plane ?? 'legacy', event: item.value.spec.event, selected: true, enabled: item.value.spec.enabled })),
    audit: { chainValid: auditFacts.chain.valid, chainHead: auditFacts.chain.head, eventCount: auditFacts.eventCount, remotePending: auditFacts.delivery.pending, remoteRequired: remoteDeliveryRequired(project, flow), coverageGaps: auditFacts.coverageGaps },
    readyTransitions,
  };
  return { governance, diagnostics, flow, state, workPackages, transitionRequirements, resources, auditFacts, transitionChainValid: transitions.chainValid };
}

/**
 * Why a Gate blocks, as one of three distinct states — or `null` when it does not block.
 *
 * These used to collapse into a single `missing-or-stale`, which reads as a filing problem even
 * when the Gate ran and genuinely failed. That mattered once a remedy was attached to the string:
 * a Change held up by a real Gate failure was told to re-run `check`, which cannot help and points
 * away from the finding the Gate reported.
 */
export function gateBlockReason(evidence: GateEvidence | null | undefined, contentRevision: string): 'missing' | 'failed' | 'stale' | null {
  if (!evidence) return 'missing';
  if (evidence.status !== 'passed') return 'failed';
  if (evidence.contentRevision !== contentRevision) return 'stale';
  return null;
}

/**
 * The way out of a block, spelled out, for the blocks where naming a command is the whole fix.
 *
 * Gate Evidence binds to the content revision at the moment the Gate runs, so an Agent that runs
 * one Gate, edits an Artifact, then runs the next has silently invalidated the first — every Gate
 * reports `passed` and the Stage still will not close. Naming the remedy turns that dead end into
 * one command. Only `stale` earns it: `failed` needs the finding fixed, and `missing` needs the
 * Gate run for the first time, neither of which this sentence describes.
 *
 * `work-package:<id>:ready` earns one for the same reason, found the same way — a live run of the
 * Solid Flow stopped dead at apply -> verify because the Change carried a work-package plan nobody
 * had dispatched. The plan's mere existence is what `resolveControlPlane` blocks on; no Flow field
 * declares a Stage work-package-driven, so an Agent that authors a plan at Design and then works
 * the packages itself hits a block whose only clue was the word "ready".
 */
export function blockRemedy(
  blocks: readonly string[],
  changeId: string,
  context: {
    /**
     * The receipt of the rework a `condition:*:stale-*` block is about, when the caller knows it.
     *
     * The remedy used to tell the reader to fetch the id from
     * `change.governance.transitions.latest`, and that is the wrong receipt: `latest` is the leg
     * that came *back*, while the condition is anchored on the leg that went *away*. Six probe runs
     * followed the instruction, were refused, and recovered only by reading the receipt chain
     * themselves. A remedy that names a value the reader can copy costs no round trip and cannot be
     * misread, so the id is passed in rather than described.
     */
    reworkReceiptId?: string | null;
    readyReceipt?: { receiptId: string; from: string; contentRevision: string; policySnapshotDigest: string };
    /**
     * Today's revision, plus whether the Change's own content moved as well as the policy snapshot.
     *
     * `artifactsMoved` is required rather than optional on purpose: the caller has to have asked
     * (`contentRevisionUnderPolicy`), because the two causes are not exclusive and the message
     * below asserts which one happened. An optional flag would reintroduce exactly the guess this
     * field exists to remove.
     */
    current?: { contentRevision: string; policySnapshotDigest: string; artifactsMoved: boolean };
  } = {},
): { code: string; message: string; remedy?: Diagnostic['remedy'] } | null {
  /*
   * Ordered before the Gate remedy deliberately. Editing an Artifact after the closing transition
   * produces both blocks at once — the receipt goes stale and every Gate it bound goes stale with
   * it — and only one remedy is reported. Re-running the Gates is the advice for the second block
   * and useless for the first: `ready-to-archive` is a synthetic Stage, absent from `flow.stages`,
   * so `legalTransitionTargets` returns nothing for it and no forward or rework move exists. A live
   * run read the Gate advice, re-ran `check`, watched the same block persist, and concluded the
   * Change was unrecoverable — it was not; the route was simply never named.
   */
  const stale = context.readyReceipt;
  if (stale && blocks.includes('transition:ready-receipt-stale')) {
    /*
     * Two different causes reach this one block, and they do not share a remedy.
     *
     * `terminalGovernanceBlocks` raises it when the receipt's `contentRevision` *or* its
     * `policySnapshotDigest` has moved — and `policySnapshotDigest` is itself an input to
     * `contentRevision` (`core/revision.ts`), so editing a Rule, Gate, policy or the Constitution,
     * or completing an `upgrade-scaffold`, moves both while no Artifact has been touched. Telling
     * that operator to restore the Artifacts is advice that cannot work: the bytes are already
     * right, and putting them back does not put the policy snapshot back. The only route left in
     * the message would then be `repair`, which discards a receipt and voids an approval that is
     * still perfectly good for the content it was given for.
     *
     * They are not exclusive, and the first version of this branch wrote as if they were: it said
     * flatly "not because this Change was edited" and promised that restoring the resource would
     * close the Change on the approval it already had. An operator who had done both — edited an
     * Artifact *and* completed an `upgrade-scaffold`, which this release forces on every project
     * that takes the new Rule version — would follow that to the letter and watch the block
     * survive, with nothing in the message to explain why. `artifactsMoved` is the answer to the
     * question the message was assuming: it re-runs the content formula over today's bytes under
     * the receipt's own policy digest, so each of the three cases gets the remedy that works.
     */
    const policyMoved = Boolean(context.current) && stale.policySnapshotDigest !== context.current!.policySnapshotDigest;
    const repair = `\`xforge transition repair --change ${changeId} --receipt ${stale.receiptId}\` discards that receipt and returns the Change to ${stale.from} for rework, which voids the archive approval — an approval is bound to what it was given for.`;
    const artifactRestore = `restore the Artifacts to the content the receipt was given for (revision ${stale.contentRevision} under policy snapshot ${stale.policySnapshotDigest})`;
    if (policyMoved && !context.current!.artifactsMoved) {
      return {
        code: 'XFORGE_READY_RECEIPT_STALE_REMEDY',
        message: `The closing transition receipt is stale because the governing policy snapshot changed, not because this Change was edited — the Artifacts still digest to what the receipt was given for. The receipt carries ${stale.policySnapshotDigest} and the project now resolves ${context.current!.policySnapshotDigest}. A Rule, Gate, PermissionPolicy, Hook, Flow or the Constitution changed under it — a completed \`upgrade-scaffold\` does this too. Restoring the Artifacts cannot clear it, because the policy snapshot is an input to the content revision. The cheap route is to put the governing resource back as it was and re-run \`xforge check --change ${changeId}\`; the Change then closes on the approval it already has. Otherwise, ${repair}`,
      };
    }
    if (policyMoved) {
      return {
        code: 'XFORGE_READY_RECEIPT_STALE_REMEDY',
        message: `The closing transition receipt is stale on both counts: the governing policy snapshot moved (the receipt carries ${stale.policySnapshotDigest}, the project now resolves ${context.current!.policySnapshotDigest} — a Rule, Gate, PermissionPolicy, Hook, Flow or the Constitution changed, and a completed \`upgrade-scaffold\` does this too) and this Change has been edited since. Undoing either one alone leaves the block in place. To keep the existing approval both have to go back: put the governing resource back as it was and ${artifactRestore}, then re-run \`xforge check --change ${changeId}\`. Otherwise, ${repair}`,
      };
    }
    return {
      code: 'XFORGE_READY_RECEIPT_STALE_REMEDY',
      message: `The closing transition receipt is bound to content revision ${stale.contentRevision}, and this Change has been edited since. Two routes, and they differ in what they preserve: restore the Artifacts to ${stale.contentRevision} to keep the existing approval, or ${repair}`,
    };
  }

  /*
   * Ordered before the Gate remedies: this one is answered by a person, once, for the project, and
   * every Gate block underneath it is downstream of that answer going unrecorded.
   */
  const undeclared = blocks
    .map((block) => /^verification:([A-Za-z0-9][A-Za-z0-9._-]*):undeclared$/.exec(block)?.[1])
    .filter((gate): gate is string => Boolean(gate));
  if (undeclared.length > 0) {
    const subject = undeclared.length === 1 ? `Gate ${undeclared[0]} runs` : `Gates ${undeclared.join(', ')} run`;
    return {
      code: 'XFORGE_VERIFICATION_UNDECLARED_BLOCKS_START',
      message: `This Flow's ${subject} whatever the project declares under manifest.verification — currently nothing, so ${undeclared.length === 1 ? 'it refuses' : 'they refuse'} rather than passing. It is asked here, at this Change's first transition, because it is answerable without any Change existing and refuses a later Stage either way: the alternative is meeting it after the planning is written and an approval has been spent. Record what this project actually verifies itself with, all of them in one pass — declaring one leaves the next to refuse a Stage further along. Do not answer with whatever command happens to exist: a test command on a repository with no tests passes the Gate while asserting nothing, which is the failure this Gate exists to prevent. \`xforge verification retire\` withdraws a declaration later, keeping the record of who withdrew it and why.`,
      remedy: { commands: undeclared.map((gate) => verificationDeclareArgv(gate)) },
    };
  }

  if (blocks.some((block) => /^gate:.+:stale$/.test(block))) {
    /* Plain `check` runs the current Stage's whole Gate set. `--all-gates` would also run Gates
       belonging to Stages the Change has not reached, which cannot pass yet and is not the advice. */
    return {
      code: 'XFORGE_GATE_EVIDENCE_STALE_REMEDY',
      /*
       * The remedy said why it staled and not how to stop it staling again.
       *
       * A Stage whose Artifact must record what the Gates reported has an ordering problem the
       * message never named: cite a Gate and the citation moves the content revision, staling the
       * Gate that was just cited. Four measured runs met it; the three that wrote the citing
       * Artifact last spent two `check` runs, and the one that wrote it first spent four plus three
       * rounds of editing. The order is not a preference, it is the one that terminates.
       */
      message: `Gate Evidence is bound to the content revision, so editing any Artifact after a Gate ran makes that Gate stale. Run \`xforge check --change ${changeId}\` after your last write to re-run this Stage's Gates against the current content. If an Artifact of this Stage has to record what the Gates reported, write it last: everything the Gates read first, then one \`check\`, then that Artifact quoting it, then a final \`check\`. Writing it earlier means citing results that do not exist yet and staling them when you correct it.`,
    };
  }

  /*
   * A condition ledger that is not on disk at all, which had no remedy and is the commonest block.
   *
   * `blockRemedy` answered the stale case, the independent-review case and the work-package cases,
   * and returned null for `condition:<key>:ledger-missing-*`. So `transition` refused with two bare
   * tokens and nothing else, while `stage` at the same Stage reported the ledger's Artifact in
   * `owes` with its full instruction and outline. Same block, same moment, and whether the reader
   * learned what to write depended on which command they had reached for. A walk of the Major Flow
   * met exactly that at clarify.
   *
   * The remedy is `stage`, not a hand-written description of the ledger: the shape belongs to the
   * Flow's Artifact instruction, which `stage` already carries and which this sentence would
   * otherwise duplicate and then drift from.
   */
  const missingLedger = blocks
    .map((block) => /^condition:([A-Za-z0-9][A-Za-z0-9._-]*):ledger-missing-expected-(.+)$/.exec(block))
    .find((match) => match !== null);
  if (missingLedger) {
    const [, key, expected] = missingLedger;
    return {
      code: 'XFORGE_CONDITION_LEDGER_MISSING_REMEDY',
      message: `This Stage cannot close until the ${key} ledger under evidence/conditions/ exists and declares \`status: ${expected}\`. Nothing has been written there yet, which is a different state from a ledger that answers nothing: an empty \`entries\` list is an assertion that there was nothing to decide, and a missing file asserts nothing at all. \`xforge stage --change ${changeId}\` reports this ledger among the Artifacts the Stage owes, with the instruction and outline its Flow declares -- write it from that rather than from this sentence, which cannot carry the shape.`,
      remedy: { commands: [['xforge', 'stage', '--change', changeId]] },
    };
  }

  /* A ledger whose decisions predate the rework that reopened their inputs. Named per entry, because
     the answer is per entry: some will survive being asked again and some will not, and a message
     saying "the ledger is stale" would not tell anyone which. */
  const staleLedger = blocks.map((block) => /^condition:([A-Za-z0-9][A-Za-z0-9._-]*):stale-(.+)$/.exec(block)).find((match) => match !== null);
  if (staleLedger) {
    const [, key, list] = staleLedger;
    /* Precomputed, and interpolated as a bare identifier: the catalogue scanner reads these
       messages out of the source, and an expression inside `${}` reduced this one to an empty
       string -- `xforge explain` then had nothing to print for a code whose whole job is to say
       what to do. */
    const namedReceipt = context.reworkReceiptId ?? '<the receiptId of the Transition that went backwards>';
    const named = list!.split('+');
    const subject = named.length === 1 ? `entry ${named[0]} was` : `entries ${named.join(', ')} were`;
    return {
      code: 'XFORGE_CONDITION_LEDGER_STALE_REMEDY',
      message: `This Change went back past the Stage that decided "${key}" and has returned, so ${subject} decided against inputs that were rewritten afterwards. Put each one to whoever decides it again, against the current Artifacts, and record the answer in \`evidence/conditions/${key}.yaml\` — a decision that still holds is confirmed, not assumed. Each entry then names the rework it stands after, as \`decidedAfter: ${namedReceipt}\` — copy that id from here. It is the receipt of the Transition that went backwards, the one whose \`to\` Stage comes before its \`from\`, and it is not the same receipt as \`transitions.latest\`, because latest is the leg that came back. \`decidedAt\` is no longer what clears this, so moving it changes nothing. Every entry needs the field, including one first decided after the rework — for that one it is a plain statement of when it was taken.`,
    };
  }

  /*
   * The condition family had no remedy at all, and two of its blocks have an exact command.
   *
   * `blockRemedy` answered three block shapes and returned null for every `condition:*`, which put
   * the one Stage that can be blocked by `independentReview` — Verify — in the position of naming a
   * problem without naming the route out. That matters most in the plan-less delivery shape, which
   * `xforge-apply` expressly permits: `xforge-verify` describes reviewing work packages, and in that
   * shape there are none, so the Skill in hand describes a procedure for objects that do not exist.
   * `xforge check` says this at Apply (`XFORGE_WORK_PACKAGE_PLAN_ABSENT`), which can be many turns
   * earlier; this says it where the block actually appears.
   */
  const unreviewedPackages = blocks.flatMap((block) => /^condition:independentReview:unreviewed-(.+)$/.exec(block)?.[1]?.split('+') ?? []);
  if (unreviewedPackages.length > 0) {
    const commands = unreviewedPackages.map((id) => `\`xforge work-package acknowledge --change ${changeId} --package ${id} --as reviewer --evidence <path>\``).join(', ');
    return {
      remedy: {
        commands: unreviewedPackages.map((id) => ['xforge', 'work-package', 'acknowledge', '--change', changeId, '--package', id, '--as', 'reviewer', '--evidence', '<path>']),
      },
      code: 'XFORGE_INDEPENDENT_REVIEW_REMEDY',
      message: `This Flow requires every delivered work package to carry a Reviewer acknowledgement before Verify closes. The Reviewer is read-only and cannot write its own evidence: transcribe its returned result verbatim to \`<change>/evidence/agents/<package>/review/<execution>.md\` -- the \`review/\` subdirectory and the \`.md\` are both load-bearing, because \`evidence/agents/<package>/*.yaml\` is where delivery records live and a transcript written there is read as one -- then record it — ${commands}.`,
    };
  }
  if (blocks.includes('condition:independentReview:review-missing') || blocks.includes('condition:independentReview:review-stale')) {
    const stale = blocks.includes('condition:independentReview:review-stale');
    return {
      code: 'XFORGE_INDEPENDENT_REVIEW_REMEDY',
      message: stale
        ? `A Change-level review is recorded, but it covers an earlier content revision than this Change now has — the work moved after it was reviewed. Review the current content, write the result to \`<change>/evidence/review/<name>.md\`, and record it with \`xforge review acknowledge --change ${changeId} --evidence <that path>\`.`
        : `This Flow requires an independent review of the delivered work, and this Change has no work-package plan for the per-package form to attach to — so it needs one Change-level review. Have a reviewer read the delivered diff, write the result to \`<change>/evidence/review/<name>.md\` (it must live under that directory so it archives with the Change), and record it with \`xforge review acknowledge --change ${changeId} --evidence <that path>\`. There is no --by: the actor comes from the environment.`,
    };
  }

  const undispatched = blocks.flatMap((block) => /^work-package:(.+):ready$/.exec(block)?.[1] ?? []);
  if (undispatched.length > 0) {
    const packages = undispatched.map((id) => `\`xforge work-package dispatch --change ${changeId} --package ${id}\``).join(', ');
    return {
      code: 'XFORGE_WORK_PACKAGE_UNDISPATCHED_REMEDY',
      message: `Apply cannot close while a package in this Change's work-package plan has never been dispatched. Dispatch each one, have its Worker record a delivery, then run \`xforge check --change ${changeId}\` to bind the deliveries: ${packages}.`,
      /* Every package, then the bind -- naming the first dispatch alone would name a step that does
         not finish the job, which is the whole reason this is a list. */
      remedy: {
        commands: [
          ...undispatched.map((id) => ['xforge', 'work-package', 'dispatch', '--change', changeId, '--package', id]),
          ['xforge', 'check', '--change', changeId],
        ],
      },
    };
  }

  /*
   * `failed` has a command now, so it gets one.
   *
   * It was grouped with the statuses "waiting on the Worker's delivery … which is work, not a
   * command this sentence could name", and that was true while `dispatch` refused anything but
   * `ready`. A rejected review leaves the package here, and three live runs reached this state and
   * found nothing naming the way on — one closed the loop only by reading the compiled source. The
   * work is still work; what this can name is the command that lets the work start again.
   */
  const failed = blocks.flatMap((block) => /^work-package:(.+):failed$/.exec(block)?.[1] ?? []);
  if (failed.length > 0) {
    const packages = failed.map((id) => `\`xforge work-package dispatch --change ${changeId} --package ${id}\``).join(', ');
    return {
      code: 'XFORGE_WORK_PACKAGE_FAILED_REMEDY',
      message: `A delivery in this Change's work-package plan is recorded as failed — which is where a rejected review leaves it. Fix what the delivery or the review names, then dispatch the package again: ${packages}. That mints a new execution, so the delivery a reviewer already read stays on disk as they read it, and the new attempt is measured from its own base commit. Commit the dispatch receipt before the work, or the two share a commit and there is nothing between base and head to deliver.`,
    };
  }

  /* Every remaining status — dispatched, in-progress — is waiting on the Worker's delivery, which is
     work, not a command this sentence could name. */
  return null;
}

export async function terminalGovernanceBlocks(
  project: ProjectContext,
  control: ResolvedControlPlane,
  options: { auditFacts?: ChangeAuditFacts } = {},
): Promise<string[]> {
  const { governance, flow } = control;
  const blocks: string[] = [];
  /* The counterpart of the per-transition block in `resolveControlPlane`. Archive reads the same
     receipt chain to decide which Stage's Gates it must re-check, so a chain that does not resolve
     to one history cannot close a Change either — the chain-invalid diagnostic is a warning now,
     and this is what stops it from becoming a silent pass. */
  if (!control.transitionChainValid) blocks.push('transition-chain:invalid');
  if (governance.currentStage !== 'ready-to-archive') blocks.push('transition:ready-to-archive');
  const readyReceipt = governance.transitions.at(-1);
  if (!readyReceipt || readyReceipt.to !== 'ready-to-archive') {
    blocks.push('transition:ready-receipt-missing');
  } else {
    /* gitHead is audit metadata: a commit that changes no governed content is not staleness. */
    if (readyReceipt.contentRevision !== governance.revision.contentRevision || readyReceipt.policySnapshotDigest !== governance.revision.policySnapshotDigest) {
      blocks.push('transition:ready-receipt-stale');
    }
    const sourceStage = flow.stages.find((stage) => stage.id === readyReceipt.from);
    const sourceExit = sourceStage ? structuredExit(sourceStage) : {};
    const sourceGates: GateEvidence[] = [];
    for (const gateId of [...new Set([...(sourceStage?.gates ?? []), ...(sourceExit.gates ?? [])])]) {
      const evidence = await readGateEvidence(project, control.state.id, gateId, control.resources);
      const boundToTransition = Boolean(evidence && readyReceipt.gates.includes(evidence.digest) && evidence.stateRevision === readyReceipt.stateRevisionBefore);
      const boundToArchiveRecheck = Boolean(evidence && evidence.contentRevision === governance.revision.contentRevision);
      /* Archive accepts Evidence bound either to the closing transition or to a re-check at the
         current revision, so staleness here is its own rule — but missing and failed are not. */
      if (!evidence) blocks.push(`gate:${gateId}:missing`);
      else if (evidence.status !== 'passed') blocks.push(`gate:${gateId}:failed`);
      else if ((!boundToTransition && !boundToArchiveRecheck) || evidence.policySnapshotDigest !== governance.revision.policySnapshotDigest) {
        blocks.push(`gate:${gateId}:stale`);
      } else sourceGates.push(evidence);
    }
    /*
     * Archive re-decides the closing Stage's Gates rather than trusting the receipt's word for them,
     * and its exit conditions are Evidence of the same kind, so they are re-decided here too — all
     * of them, by iteration rather than by name.
     *
     * Naming one was the bug. This read `sourceExit.conditions[verificationReceipt]` and nothing
     * else, so `independentReview` — the condition Major declares specifically to stop a Change
     * being implemented and signed off by a single executor — was decided once, at the closing
     * transition, and never looked at again. `contentRevision` does not digest `evidence/review/`,
     * so deleting a review transcript afterwards moved no revision, staled no receipt, and archived
     * a Change whose review evidence was gone. Any condition a project declares in its own Flow had
     * the same hole for the same reason. Only the Flow that declares a condition pays for it.
     */
    const identities = await knownIdentities(project, control.state.id, governance.approvals);
    const sources = await collectConditionSources(project, control.state.id, Object.keys(sourceExit.conditions ?? {}));
    for (const [key, declared] of Object.entries(sourceExit.conditions ?? {})) {
      const expected = exitConditionExpectation(declared, control.state.classification);
      if (expected === null) continue;
      const condition = decideStageCondition(project.changesPath, control.state.id, key, expected, {
        state: control.state,
        /* The resolve's own plan. Reading it off `control.state` would work today only because the
           resolve now fills that in; taking it from the resolution keeps the two from drifting. */
        workPackages: control.workPackages,
        contentRevision: governance.revision.contentRevision,
        gates: sourceGates,
        identities,
        /* Receipt-validation diagnostics are already reported by the resolve this was handed; a
           second copy from the archive path would double every one of them in the envelope. */
        diagnostics: [],
        /* Measured against the Stage the closing receipt left, which is the Stage whose exit
           declared the condition — the same subject `sourceExit` is read from. */
        reworkCutoff: sourceStage ? conditionReworkCutoff(flow, governance.transitions, sourceStage.id) : null,
        sources,
      });
      if (!condition.satisfied) blocks.push(`condition:${key}:${condition.reason}`);
    }
  }
  let implementers: ReadonlySet<string> | null = null;
  for (const policyId of flow.terminal.archive.approvals ?? []) {
    const policy = policyById(flow, policyId);
    if (!policy) { blocks.push(`approval-policy:${policyId}:missing`); continue; }
    if (policy.separationOfDuties && implementers === null) implementers = await changeImplementers(project, control.state.id, control.state);
    const result = approvalsForPolicy(governance.approvals, policy, 'archive', {
      governingRevision: governance.revision.governingRevision!, stateRevision: governance.revision.stateRevision, implementers: implementers ?? undefined,
    });
    if (result.rejected) blocks.push(`approval:${policyId}:rejected`);
    if (!result.separationSatisfied) blocks.push(`approval:${policyId}:separation-of-duties`);
    if (result.missing > 0) blocks.push(`approval:${policyId}:missing-${result.missing}`);
  }
  const policy = flow.terminal.archive.auditPolicy ?? flow.governance?.audit;
  const remoteRequired = remoteDeliveryRequired(project, flow);
  /*
   * Archive is decided from the Change's own committed audit index when the gitignored local chain
   * is missing, so a fresh clone or a CI runner can close a Change the laptop that ran it started.
   */
  const facts = options.auditFacts ?? control.auditFacts ?? await readChangeAuditEvents(project, control.state.id);
  for (const type of policy?.requiredEventTypes ?? []) if (!facts.eventTypes.includes(type)) blocks.push(`audit:${type}:missing`);
  if (!facts.chain.valid) blocks.push('audit:chain-invalid');
  if (!facts.trusted) blocks.push('audit:untrusted');
  if (policy?.runtimeCoverage === 'required' && facts.coverageGaps.length > 0) blocks.push('audit:runtime-coverage-gap');
  if (remoteRequired && facts.delivery.pending > 0) blocks.push('audit:remote-pending');
  if (remoteRequired && !project.manifest.audit?.remote) blocks.push('audit:remote-not-configured');
  return [...new Set(blocks)];
}
