import type { ChangeConfig, ChangeState, Diagnostic, Flow, ProjectContext, StageFlow } from '../types.js';
import { diagnostic } from './errors.js';
import { flowArchiveOperation, isStageFlow, loadFlows } from './flow-resolver.js';
import { INDEPENDENT_REVIEW_CONDITION } from './control-plane.js';
import { resolvedResourceEntries } from './lockfile.js';
import { stableStringify } from './hash.js';
import { normalizeRelative } from './path-safety.js';
import { loadSelectedResources, type SelectedResources } from './resource-loader.js';
import { resolveChangeState } from './flow-resolver.js';
import { resolveWorkPackages } from './work-packages.js';
import { normalizeRule } from './governance.js';
import { loadTransitionReceipts } from './control-plane.js';
import { validateChangeSpecDeltas } from './spec-delta.js';
import { validateArtifactMarkers } from './artifact-markers.js';
import { flowSkillConformanceDiagnostics } from './flow-skill-conformance.js';

export interface StructureResult {
  diagnostics: Diagnostic[];
  resources: SelectedResources;
  change: ChangeState | null;
}

const IMPACT_KEYS = ['security', 'privacy', 'publicApi', 'dataMigration'] as const;

function activeImpacts(classification: ChangeConfig['classification']): Array<(typeof IMPACT_KEYS)[number]> {
  return IMPACT_KEYS.filter((key) => classification[key]);
}

/**
 * What a Change gives up by delivering without a work-package plan, said out loud.
 *
 * `resolveWorkPackages` returns no diagnostics when `work-packages.yaml` is absent, and it is right
 * not to: `xforge-apply` explicitly sanctions "a short Main-Agent plan for one small task", so the
 * file's absence is a legitimate delivery shape rather than an error. But the mechanisms that hang
 * off it disappear with it, and a live Major run showed how quietly: a high-risk Change was
 * delivered without a plan, and the operator learned only afterwards that dispatch receipts,
 * delivery records and the worktree write boundary had never been in force. Nothing had said so.
 *
 * Reported only for Flows that declare `independentReview`, because those are the Flows for which
 * a plan carries governance rather than convenience. Emitting this on every Quick Change — where
 * no plan is the norm and nothing is lost — would be the permanent, unactionable finding this
 * codebase already refuses to produce elsewhere.
 */
function workPackageDegradation(flow: StageFlow, changeId: string, changesPath: string): Diagnostic[] {
  const declaresReview = flow.stages.some((stage) => {
    const exit = stage.exit;
    return Boolean(exit && 'conditions' in exit && exit.conditions?.[INDEPENDENT_REVIEW_CONDITION] !== undefined);
  });
  if (!declaresReview) return [];
  return [diagnostic(
    'XFORGE_WORK_PACKAGE_PLAN_ABSENT',
    `This Change is delivering without work-packages.yaml, which is a permitted shape — and these stop applying with it: dispatch receipts (so no execution_id, state_revision or policy_snapshot_digest binds the work), delivery records with their done_when evidence, and the worktree write boundary, which becomes a matter of instruction rather than something the CLI enforces. Flow ${flow.metadata.name} also declares the ${INDEPENDENT_REVIEW_CONDITION} exit condition, which without a plan has no packages to review — so it now requires a Change-level review instead, and Verify will not close until one exists: record it with \`xforge review acknowledge --change ${changeId} --evidence <path>\`. To keep the per-package mechanisms as well, deliver against a plan and dispatch each package.`,
    `${changesPath}/${changeId}`,
    'info',
  )];
}

function requiredPolicyMatches(flow: StageFlow, classification: ChangeConfig['classification']): boolean {
  const required = flow.policy.requiredWhen;
  if (!required) return false;
  const riskMatches = required.risk?.includes(classification.risk) ?? false;
  const impacts = activeImpacts(classification);
  const impactMatches = required.anyImpact?.some((impact) => impacts.includes(impact)) ?? false;
  return riskMatches || impactMatches;
}

function eligibilityProblems(flow: StageFlow, config: ChangeConfig): string[] {
  const problems: string[] = [];
  const eligible = flow.policy.eligibleWhen;
  if (!eligible.risk.includes(config.classification.risk)) problems.push(`risk ${config.classification.risk} is not eligible`);
  if (eligible.criticalImpacts === 'forbidden' && activeImpacts(config.classification).length > 0) problems.push('critical impacts are forbidden');
  if (eligible.maxModules !== undefined && config.scope.modules.length > eligible.maxModules) problems.push(`module count exceeds ${eligible.maxModules}`);
  return problems;
}

/**
 * Reports whether the Flow a Change selected is strong enough for how the Change classified
 * itself. Shared by checkStructure and commands/transition.ts so a mismatched Flow is refused at
 * the first Stage transition instead of surfacing only at archive.
 */
export function flowEligibilityDiagnostics(
  flow: Flow,
  config: ChangeConfig,
  flows: Iterable<Flow>,
  changePath: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const classification = config.classification;
  const requiredFlows = [...flows].filter(isStageFlow).filter((candidate) => requiredPolicyMatches(candidate, classification));
  const satisfiesRequired = requiredFlows.some((candidate) => candidate.metadata.name === flow.metadata.name);
  const requiredPolicyDiagnostic = diagnostic(
    'XFORGE_FLOW_REQUIRED_POLICY',
    `Classification requires one of the policy-mandated Flows: ${requiredFlows.map((candidate) => candidate.metadata.name).join(', ')}.`,
    changePath,
  );

  if (isStageFlow(flow)) {
    const problems = eligibilityProblems(flow, config);
    if (problems.length > 0) diagnostics.push(diagnostic(
      'XFORGE_FLOW_TOO_WEAK',
      `Flow ${flow.metadata.name} is not eligible for this Change: ${problems.join('; ')}.`,
      changePath,
    ));
    if (requiredFlows.length > 0 && !satisfiesRequired) diagnostics.push(requiredPolicyDiagnostic);
    return diagnostics;
  }

  // Legacy v1alpha1 Flows carry no policy block, so the escalation target is derived from the
  // policy-bearing Flows the project actually ships rather than from a hard-coded Flow name.
  const critical = activeImpacts(classification).length > 0;
  if (flow.metadata.name === 'quick') {
    if (config.scope.modules.length > 1) diagnostics.push(diagnostic('XFORGE_FLOW_TOO_WEAK', 'A cross-module Change cannot use quick.', changePath));
    if (classification.risk !== 'low' || critical) diagnostics.push(diagnostic('XFORGE_FLOW_TOO_WEAK', 'quick is limited to low-risk Changes with no critical impact flags.', changePath));
  }
  if (requiredFlows.length > 0 && !satisfiesRequired) diagnostics.push(requiredPolicyDiagnostic);
  return diagnostics;
}

export async function checkStructure(project: ProjectContext, changeId?: string): Promise<StructureResult> {
  const diagnostics = [...project.diagnostics];
  const flowResult = await loadFlows(project);
  diagnostics.push(...flowResult.diagnostics);
  const resources = await loadSelectedResources(project);
  diagnostics.push(...resources.diagnostics);
  const resolvedEntries = await resolvedResourceEntries(project, resources);
  if (stableStringify(project.lock?.resources ?? []) !== stableStringify(resolvedEntries)) {
    diagnostics.push(diagnostic('XFORGE_LOCK_RESOURCES_MISMATCH', 'Lockfile resource identities or content digests differ from selected project assets.', 'xforge/lock.yaml', 'warning'));
  }

  for (const flow of flowResult.flows.values()) {
    for (const gate of flowArchiveOperation(flow).mandatoryGates) {
      if (!project.manifest.scaffold.gates.includes(gate)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_GATE_DISABLED', `Flow ${flow.metadata.name} requires non-enabled Gate ${gate}.`, `xforge/flows/${flow.metadata.name}.yaml`));
      } else if (!resources.gates.has(gate)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_GATE_MISSING', `Flow ${flow.metadata.name} requires missing Gate ${gate}.`, `xforge/flows/${flow.metadata.name}.yaml`));
      }
    }
    if (isStageFlow(flow)) {
      if (!flow.governance) {
        diagnostics.push(diagnostic(
          'XFORGE_FLOW_GOVERNANCE_MISSING',
          `Flow ${flow.metadata.name} declares no governance block, so xforge transition and xforge approve are unavailable for Changes on this Flow.`,
          `xforge/flows/${flow.metadata.name}.yaml`,
          'warning',
        ));
      }
      for (const stage of flow.stages) {
        if (!project.manifest.scaffold.skills.includes(stage.skill)) {
          diagnostics.push(diagnostic('XFORGE_FLOW_SKILL_DISABLED', `Flow ${flow.metadata.name} Stage ${stage.id} references non-enabled Skill ${stage.skill}.`, `xforge/flows/${flow.metadata.name}.yaml`));
        } else if (!resources.skills.has(stage.skill)) {
          diagnostics.push(diagnostic('XFORGE_FLOW_SKILL_MISSING', `Flow ${flow.metadata.name} Stage ${stage.id} references missing Skill ${stage.skill}.`, `xforge/flows/${flow.metadata.name}.yaml`));
        }
      }
      diagnostics.push(...await flowSkillConformanceDiagnostics(flow, resources));
      if (!project.manifest.scaffold.skills.includes(flow.terminal.archive.handler)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_SKILL_DISABLED', `Flow ${flow.metadata.name} archive handler is not enabled: ${flow.terminal.archive.handler}.`, `xforge/flows/${flow.metadata.name}.yaml`));
      } else if (!resources.skills.has(flow.terminal.archive.handler)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_SKILL_MISSING', `Flow ${flow.metadata.name} archive handler Skill is missing: ${flow.terminal.archive.handler}.`, `xforge/flows/${flow.metadata.name}.yaml`));
      }
    }
  }

  const agentIds = new Set(project.manifest.scaffold.agents);
  const moduleIds = new Set(project.manifest.project.modules.map((item) => item.id));
  const approvalPolicyIds = new Set(
    [...flowResult.flows.values()].flatMap((flow) => (isStageFlow(flow) ? (flow.governance?.approvalPolicies.map((policy) => policy.id) ?? []) : [])),
  );
  for (const [id, agent] of resources.agents) {
    for (const caller of agent.value.spec.delegation.callableBy) {
      if (caller !== 'main' && !agentIds.has(caller)) diagnostics.push(diagnostic('XFORGE_AGENT_CALLER_UNKNOWN', `Agent ${id} allows unknown caller ${caller}.`, agent.yamlPath));
    }
  }
  for (const [id, rule] of resources.rules) {
    const normalized = normalizeRule(rule.value);
    for (const module of normalized.modules) {
      if (!moduleIds.has(module)) diagnostics.push(diagnostic('XFORGE_RULE_MODULE_UNKNOWN', `Rule ${id} references unknown module ${module}.`, rule.yamlPath));
    }
    for (const approvalRef of normalized.approvalRefs) {
      if (!approvalPolicyIds.has(approvalRef)) diagnostics.push(diagnostic('XFORGE_RULE_APPROVAL_UNKNOWN', `Rule ${id} references unknown Approval policy ${approvalRef}.`, rule.yamlPath));
    }
    for (const scopedPath of normalized.paths) {
      try { normalizeRelative(scopedPath, `Rule ${id} path`); }
      catch (error) { diagnostics.push(...((error as { diagnostics?: Diagnostic[] }).diagnostics ?? [])); }
    }
  }
  for (const [id, policy] of resources.policies) {
    for (const scopedPath of policy.value.spec.match.paths ?? []) {
      try { normalizeRelative(scopedPath, `PermissionPolicy ${id} path`); }
      catch (error) { diagnostics.push(...((error as { diagnostics?: Diagnostic[] }).diagnostics ?? [])); }
    }
  }
  for (const provider of project.manifest.approvals?.providers ?? []) {
    if (provider.type === 'mcp' && !resources.mcpServers.has(provider.mcpServer)) {
      diagnostics.push(diagnostic('XFORGE_APPROVAL_MCP_SERVER_UNKNOWN', `Approval provider ${provider.id} references unknown McpServer ${provider.mcpServer}.`, 'xforge/manifest.yaml'));
    }
  }

  let change: ChangeState | null = null;
  if (changeId) {
    const resolved = await resolveChangeState(project, changeId, flowResult.flows);
    diagnostics.push(...resolved.diagnostics);
    change = resolved.state;
    diagnostics.push(...flowEligibilityDiagnostics(
      resolved.flow,
      resolved.config,
      flowResult.flows.values(),
      `${project.changesPath}/${changeId}/change.yaml`,
    ));
    diagnostics.push(...await validateChangeSpecDeltas(project, changeId));
    diagnostics.push(...await validateArtifactMarkers(project, changeId));
    for (const module of resolved.config.scope.modules) {
      if (!moduleIds.has(module)) diagnostics.push(diagnostic('XFORGE_CHANGE_MODULE_UNKNOWN', `Change references unknown module ${module}.`, `${project.changesPath}/${changeId}/change.yaml`));
    }
    for (const scopedPath of resolved.config.scope.paths) {
      try { normalizeRelative(scopedPath, `Change ${changeId} scope path`); }
      catch (error) { diagnostics.push(...((error as { diagnostics?: Diagnostic[] }).diagnostics ?? [])); }
    }
    let requireDeliveries = false;
    let reachedImplementation = false;
    let reviewedFlow: StageFlow | null = null;
    if (isStageFlow(resolved.flow) && resolved.flow.governance) {
      const transitions = await loadTransitionReceipts(project, changeId, resolved.flow);
      diagnostics.push(...transitions.diagnostics);
      const currentStage = transitions.receipts.at(-1)?.to ?? resolved.flow.stages[0]?.id;
      requireDeliveries = currentStage === 'verify' || currentStage === 'ready-to-archive';
      /* Located by authority rather than by the name `apply`, so a project that renames or adds an
         implementing Stage is measured by what the Stage is allowed to write, not by a string. */
      const implementing = resolved.flow.stages.findIndex((stage) => stage.authority === 'implementation-write');
      const current = resolved.flow.stages.findIndex((stage) => stage.id === currentStage);
      reachedImplementation = implementing >= 0 && (current >= implementing || currentStage === 'ready-to-archive');
      reviewedFlow = resolved.flow;
    }
    const workPackages = await resolveWorkPackages(project, changeId, resolved.config, resources, { requireDeliveries });
    diagnostics.push(...workPackages.diagnostics);
    change.workPackages = workPackages.state;
    if (reviewedFlow && reachedImplementation && !workPackages.state) {
      diagnostics.push(...workPackageDegradation(reviewedFlow, changeId, project.changesPath));
    }
  }

  return { diagnostics, resources, change };
}
