import type { ChangeState, Diagnostic, ProjectContext } from '../types.js';
import { diagnostic } from './errors.js';
import { loadFlows } from './flow-resolver.js';
import { resolvedResourceEntries } from './lockfile.js';
import { stableStringify } from './hash.js';
import { normalizeRelative } from './path-safety.js';
import { loadSelectedResources, type SelectedResources } from './resource-loader.js';
import { resolveChangeState } from './flow-resolver.js';
import { resolveWorkPackages } from './work-packages.js';

export interface StructureResult {
  diagnostics: Diagnostic[];
  resources: SelectedResources;
  change: ChangeState | null;
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
    for (const gate of flow.operations.archive.mandatoryGates) {
      if (!project.manifest.scaffold.gates.includes(gate)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_GATE_DISABLED', `Flow ${flow.metadata.name} requires non-enabled Gate ${gate}.`, `xforge/flows/${flow.metadata.name}.yaml`));
      } else if (!resources.gates.has(gate)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_GATE_MISSING', `Flow ${flow.metadata.name} requires missing Gate ${gate}.`, `xforge/flows/${flow.metadata.name}.yaml`));
      }
    }
  }

  const agentIds = new Set(project.manifest.scaffold.agents);
  const moduleIds = new Set(project.manifest.project.modules.map((item) => item.id));
  for (const [id, agent] of resources.agents) {
    for (const caller of agent.value.spec.delegation.callableBy) {
      if (caller !== 'main' && !agentIds.has(caller)) diagnostics.push(diagnostic('XFORGE_AGENT_CALLER_UNKNOWN', `Agent ${id} allows unknown caller ${caller}.`, agent.yamlPath));
    }
  }
  for (const [id, rule] of resources.rules) {
    for (const module of rule.value.spec.modules ?? []) {
      if (!moduleIds.has(module)) diagnostics.push(diagnostic('XFORGE_RULE_MODULE_UNKNOWN', `Rule ${id} references unknown module ${module}.`, rule.yamlPath));
    }
    for (const scopedPath of rule.value.spec.paths ?? []) {
      try { normalizeRelative(scopedPath, `Rule ${id} path`); }
      catch (error) { diagnostics.push(...((error as { diagnostics?: Diagnostic[] }).diagnostics ?? [])); }
    }
  }

  let change: ChangeState | null = null;
  if (changeId) {
    const resolved = await resolveChangeState(project, changeId, flowResult.flows);
    diagnostics.push(...resolved.diagnostics);
    change = resolved.state;
    const classification = resolved.config.classification;
    const critical = classification.security || classification.privacy || classification.publicApi || classification.dataMigration;
    if (resolved.config.scope.modules.length > 1 && resolved.flow.metadata.name === 'quick') {
      diagnostics.push(diagnostic('XFORGE_FLOW_TOO_WEAK', 'A cross-module Change cannot use quick.', `${project.changesPath}/${changeId}/change.yaml`));
    }
    if ((classification.risk !== 'low' || critical) && resolved.flow.metadata.name === 'quick') {
      diagnostics.push(diagnostic('XFORGE_FLOW_TOO_WEAK', 'quick is limited to low-risk Changes with no critical impact flags.', `${project.changesPath}/${changeId}/change.yaml`));
    }
    if ((classification.risk === 'high' || critical) && resolved.flow.metadata.name !== 'prime') {
      diagnostics.push(diagnostic('XFORGE_FLOW_PRIME_REQUIRED', 'High risk or a critical impact flag requires prime.', `${project.changesPath}/${changeId}/change.yaml`));
    }
    for (const module of resolved.config.scope.modules) {
      if (!moduleIds.has(module)) diagnostics.push(diagnostic('XFORGE_CHANGE_MODULE_UNKNOWN', `Change references unknown module ${module}.`, `${project.changesPath}/${changeId}/change.yaml`));
    }
    for (const scopedPath of resolved.config.scope.paths) {
      try { normalizeRelative(scopedPath, `Change ${changeId} scope path`); }
      catch (error) { diagnostics.push(...((error as { diagnostics?: Diagnostic[] }).diagnostics ?? [])); }
    }
    const workPackages = await resolveWorkPackages(project, changeId, resolved.config, resources, { requireDeliveries: true });
    diagnostics.push(...workPackages.diagnostics);
    change.workPackages = workPackages.state;
  }

  return { diagnostics, resources, change };
}
