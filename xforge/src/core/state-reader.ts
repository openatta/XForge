import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { TargetId } from '../constants.js';
import { TARGETS } from '../constants.js';
import { capabilityMatrix } from '../adapters/index.js';
import type { ChangeState, Diagnostic, ProjectContext } from '../types.js';
import { diagnostic } from './errors.js';
import { flowApplyOperation, flowArchiveOperation, flowArtifacts, isStageFlow, loadFlows, resolveChangeState } from './flow-resolver.js';
import { safeResolve } from './path-safety.js';
import { loadSelectedResources } from './resource-loader.js';
import { resolvedResourceEntries } from './lockfile.js';
import { stableStringify } from './hash.js';
import { resolveWorkPackages } from './work-packages.js';
import { installationSummary, readOwnership } from '../install/ownership.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function directoriesAt(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export interface StateOptions {
  change?: string;
  kind?: 'skills' | 'agents' | 'rules' | 'hooks' | 'gates' | 'scripts';
  target?: TargetId;
}

export async function readState(project: ProjectContext, options: StateOptions): Promise<{
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
}> {
  const diagnostics = [...project.diagnostics];
  const flowResult = await loadFlows(project);
  diagnostics.push(...flowResult.diagnostics);
  const resources = await loadSelectedResources(project);
  diagnostics.push(...resources.diagnostics);
  if (stableStringify(project.lock?.resources ?? []) !== stableStringify(await resolvedResourceEntries(project, resources))) {
    diagnostics.push(diagnostic('XFORGE_LOCK_RESOURCES_MISMATCH', 'Lockfile resource identities or content digests differ from selected project assets.', 'xforge/lock.yaml', 'warning'));
  }

  if (options.target && !TARGETS.includes(options.target)) {
    diagnostics.push(diagnostic('XFORGE_TARGET_UNKNOWN', `Unknown target: ${options.target}`));
  }

  const specsAbsolute = await safeResolve(project.root, project.specsPath);
  const changesAbsolute = await safeResolve(project.root, project.changesPath);
  const specs = await exists(specsAbsolute)
    ? (await fg('**/*.md', { cwd: specsAbsolute, onlyFiles: true, followSymbolicLinks: false })).sort()
    : [];
  const changes = await directoriesAt(changesAbsolute);
  const flowSummaries = [...flowResult.flows.values()].map((flow) => {
    const apply = flowApplyOperation(flow);
    const archive = flowArchiveOperation(flow);
    return {
      id: flow.metadata.name,
      version: flow.metadata.version,
      apiVersion: flow.apiVersion,
      description: flow.metadata.description,
      policy: isStageFlow(flow) ? flow.policy : null,
      stages: isStageFlow(flow) ? flow.stages.map((stage) => ({
        id: stage.id,
        skill: stage.skill,
        authority: stage.authority,
        requires: stage.requires,
        produces: stage.produces,
      })) : null,
      artifacts: flowArtifacts(flow).map((artifact) => ({ id: artifact.id, generates: artifact.generates, requires: artifact.requires })),
      applyRequires: apply.requires,
      archiveRequires: archive.requires,
      mandatoryGates: archive.mandatoryGates,
    };
  });

  let selectedChange: ChangeState | null = null;
  let context: Record<string, unknown> | null = null;
  if (options.change) {
    const resolved = await resolveChangeState(project, options.change, flowResult.flows);
    selectedChange = resolved.state;
    diagnostics.push(...resolved.diagnostics);
    const workPackages = await resolveWorkPackages(project, options.change, resolved.config, resources);
    diagnostics.push(...workPackages.diagnostics);
    selectedChange.workPackages = workPackages.state;
    const relevantRules = [...resources.rules.values()]
      .filter((rule) => !rule.value.spec.modules?.length || rule.value.spec.modules.some((id) => resolved.config.scope.modules.includes(id)))
      .map((rule) => ({ id: rule.value.metadata.name, level: rule.value.spec.level, instruction: rule.value.spec.instruction, gate: rule.value.spec.gate ?? null }));
    context = {
      constitution: project.constitution,
      rules: relevantRules,
      relatedSpecs: specs,
      nextArtifact: selectedChange.nextArtifact,
      workPackages: selectedChange.workPackages,
    };
  }

  const resourceSummary: Record<string, unknown> = {
    skills: [...resources.skills.keys()],
    agents: [...resources.agents.keys()],
    rules: [...resources.rules.keys()],
    hooks: [...resources.hooks.keys()],
    gates: [...resources.gates.keys()],
    scripts: [...resources.scripts.keys()],
  };
  const filteredResources = options.kind ? { [options.kind]: resourceSummary[options.kind] } : resourceSummary;
  const targetList = options.target ? [options.target] : project.manifest.targets;
  const installation = installationSummary(await readOwnership(project));

  return {
    data: {
      project: {
        name: project.manifest.metadata.name,
        layout: project.manifest.project.layout,
        modules: project.manifest.project.modules,
        paths: {
          specs: { value: project.specsPath, source: project.specsPathSource },
          changes: { value: project.changesPath, source: project.changesPathSource },
        },
        compatibility: project.compatibility,
      },
      scaffold: {
        version: project.manifest.scaffold.version,
        source: project.manifest.scaffold.source,
        lockedResources: project.lock?.resources ?? [],
      },
      xforge: {
        declaration: project.manifest.xforge,
        integrity: project.lock?.xforge?.integrity ?? null,
      },
      specs,
      changes,
      flows: flowSummaries,
      resources: filteredResources,
      targets: capabilityMatrix(targetList),
      installation,
      change: selectedChange,
      context,
    },
    diagnostics,
  };
}
