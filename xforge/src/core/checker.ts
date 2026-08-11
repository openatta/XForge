import type { ChangeConfig, ChangeState, Diagnostic, ProjectContext, StageFlow } from '../types.js';
import { diagnostic } from './errors.js';
import { flowArchiveOperation, isStageFlow, loadFlows } from './flow-resolver.js';
import { resolvedResourceEntries } from './lockfile.js';
import { stableStringify } from './hash.js';
import { normalizeRelative } from './path-safety.js';
import { loadSelectedResources, type SelectedResources } from './resource-loader.js';
import { resolveChangeState } from './flow-resolver.js';
import { resolveWorkPackages } from './work-packages.js';
import { normalizeRule } from './governance.js';
import { loadTransitionReceipts } from './control-plane.js';

export interface StructureResult {
  diagnostics: Diagnostic[];
  resources: SelectedResources;
  change: ChangeState | null;
}

const IMPACT_KEYS = ['security', 'privacy', 'publicApi', 'dataMigration'] as const;

function activeImpacts(classification: ChangeConfig['classification']): Array<(typeof IMPACT_KEYS)[number]> {
  return IMPACT_KEYS.filter((key) => classification[key]);
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
      for (const stage of flow.stages) {
        if (!project.manifest.scaffold.skills.includes(stage.skill)) {
          diagnostics.push(diagnostic('XFORGE_FLOW_SKILL_DISABLED', `Flow ${flow.metadata.name} Stage ${stage.id} references non-enabled Skill ${stage.skill}.`, `xforge/flows/${flow.metadata.name}.yaml`));
        } else if (!resources.skills.has(stage.skill)) {
          diagnostics.push(diagnostic('XFORGE_FLOW_SKILL_MISSING', `Flow ${flow.metadata.name} Stage ${stage.id} references missing Skill ${stage.skill}.`, `xforge/flows/${flow.metadata.name}.yaml`));
        }
      }
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
    const classification = resolved.config.classification;
    if (isStageFlow(resolved.flow)) {
      const problems = eligibilityProblems(resolved.flow, resolved.config);
      if (problems.length > 0) diagnostics.push(diagnostic(
        'XFORGE_FLOW_TOO_WEAK',
        `Flow ${resolved.flow.metadata.name} is not eligible for this Change: ${problems.join('; ')}.`,
        `${project.changesPath}/${changeId}/change.yaml`,
      ));
      const requiredFlows = [...flowResult.flows.values()]
        .filter(isStageFlow)
        .filter((flow) => requiredPolicyMatches(flow, classification));
      const selectedSatisfiesRequired = requiredFlows.some((flow) => flow.metadata.name === resolved.flow.metadata.name);
      if (requiredFlows.length > 0 && !selectedSatisfiesRequired) diagnostics.push(diagnostic(
        'XFORGE_FLOW_REQUIRED_POLICY',
        `Classification requires one of the policy-mandated Flows: ${requiredFlows.map((flow) => flow.metadata.name).join(', ')}.`,
        `${project.changesPath}/${changeId}/change.yaml`,
      ));
    } else {
      const critical = activeImpacts(classification).length > 0;
      if (resolved.config.scope.modules.length > 1 && resolved.flow.metadata.name === 'quick') {
        diagnostics.push(diagnostic('XFORGE_FLOW_TOO_WEAK', 'A cross-module Change cannot use quick.', `${project.changesPath}/${changeId}/change.yaml`));
      }
      if ((classification.risk !== 'low' || critical) && resolved.flow.metadata.name === 'quick') {
        diagnostics.push(diagnostic('XFORGE_FLOW_TOO_WEAK', 'quick is limited to low-risk Changes with no critical impact flags.', `${project.changesPath}/${changeId}/change.yaml`));
      }
      if ((classification.risk === 'high' || critical) && resolved.flow.metadata.name !== 'prime') {
        diagnostics.push(diagnostic('XFORGE_FLOW_PRIME_REQUIRED', 'High risk or a critical impact flag requires prime.', `${project.changesPath}/${changeId}/change.yaml`));
      }
    }
    for (const module of resolved.config.scope.modules) {
      if (!moduleIds.has(module)) diagnostics.push(diagnostic('XFORGE_CHANGE_MODULE_UNKNOWN', `Change references unknown module ${module}.`, `${project.changesPath}/${changeId}/change.yaml`));
    }
    for (const scopedPath of resolved.config.scope.paths) {
      try { normalizeRelative(scopedPath, `Change ${changeId} scope path`); }
      catch (error) { diagnostics.push(...((error as { diagnostics?: Diagnostic[] }).diagnostics ?? [])); }
    }
    let requireDeliveries = false;
    if (isStageFlow(resolved.flow) && resolved.flow.governance) {
      const transitions = await loadTransitionReceipts(project, changeId, resolved.flow);
      diagnostics.push(...transitions.diagnostics);
      const currentStage = transitions.receipts.at(-1)?.to ?? resolved.flow.stages[0]?.id;
      requireDeliveries = currentStage === 'verify' || currentStage === 'ready-to-archive';
    }
    const workPackages = await resolveWorkPackages(project, changeId, resolved.config, resources, { requireDeliveries });
    diagnostics.push(...workPackages.diagnostics);
    change.workPackages = workPackages.state;
  }

  return { diagnostics, resources, change };
}
