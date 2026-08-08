import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type {
  ArtifactDefinition,
  ArtifactState,
  ChangeConfig,
  ChangeState,
  Diagnostic,
  Flow,
  ProjectContext,
} from '../types.js';
import { XForgeError, diagnostic } from './errors.js';
import { assertResourceId, normalizeRelative, safeResolve, toProjectPath } from './path-safety.js';
import { validateSchema } from './validator.js';
import { loadYaml } from './yaml.js';

async function pathExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

function graphDiagnostics(flow: Flow, filePath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ids = flow.artifacts.map((item) => item.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    diagnostics.push(diagnostic('XFORGE_FLOW_ARTIFACT_DUPLICATE', 'Flow Artifact IDs must be unique.', filePath));
  }
  for (const artifact of flow.artifacts) {
    try { normalizeRelative(artifact.generates, `Artifact ${artifact.id} output`); } catch (error) {
      if (error instanceof XForgeError) diagnostics.push(...error.diagnostics);
    }
    for (const dependency of artifact.requires) {
      if (!unique.has(dependency)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_DEPENDENCY_UNKNOWN', `Artifact ${artifact.id} requires unknown Artifact ${dependency}.`, filePath));
      }
      if (dependency === artifact.id) {
        diagnostics.push(diagnostic('XFORGE_FLOW_DEPENDENCY_CYCLE', `Artifact ${artifact.id} requires itself.`, filePath));
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(flow.artifacts.map((item) => [item.id, item]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      diagnostics.push(diagnostic('XFORGE_FLOW_DEPENDENCY_CYCLE', `Flow contains a dependency cycle at ${id}.`, filePath));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.requires ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  for (const id of [...flow.operations.apply.requires, ...flow.operations.archive.requires]) {
    if (!unique.has(id)) diagnostics.push(diagnostic('XFORGE_FLOW_OPERATION_REFERENCE_UNKNOWN', `Flow operation references unknown Artifact ${id}.`, filePath));
  }
  return diagnostics;
}

export async function loadFlows(project: ProjectContext): Promise<{ flows: Map<string, Flow>; diagnostics: Diagnostic[] }> {
  const flowsDirectory = await safeResolve(project.root, 'xforge/flows');
  let names: string[];
  try {
    names = (await readdir(flowsDirectory)).filter((name) => name.endsWith('.yaml')).sort();
  } catch {
    return { flows: new Map(), diagnostics: [diagnostic('XFORGE_FLOWS_MISSING', 'xforge/flows must contain project Flow files.', 'xforge/flows')] };
  }

  const flows = new Map<string, Flow>();
  const diagnostics: Diagnostic[] = [];
  for (const name of names) {
    const relative = `xforge/flows/${name}`;
    const flow = await loadYaml<Flow>(path.join(flowsDirectory, name), relative);
    diagnostics.push(...await validateSchema('flow', flow, relative));
    if (flow.metadata?.name) {
      if (flow.metadata.name !== name.slice(0, -5)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_FILENAME_MISMATCH', 'Flow metadata.name must match its filename.', relative));
      }
      if (flows.has(flow.metadata.name)) diagnostics.push(diagnostic('XFORGE_FLOW_DUPLICATE', `Duplicate Flow ${flow.metadata.name}.`, relative));
      flows.set(flow.metadata.name, flow);
      diagnostics.push(...graphDiagnostics(flow, relative));
    }
  }
  if (!flows.has(project.manifest.flow)) {
    diagnostics.push(diagnostic('XFORGE_FLOW_NOT_FOUND', `Manifest default Flow does not exist: ${project.manifest.flow}`, 'xforge/manifest.yaml'));
  }
  return { flows, diagnostics };
}

function hasGlob(pattern: string): boolean {
  return /[*?{}[\]]/.test(pattern);
}

async function artifactOutputs(changeDirectory: string, artifact: ArtifactDefinition): Promise<string[]> {
  const pattern = normalizeRelative(artifact.generates, `Artifact ${artifact.id} output`);
  if (!hasGlob(pattern)) {
    const filePath = await safeResolve(changeDirectory, pattern);
    return await pathExists(filePath) ? [pattern] : [];
  }
  const outputs = (await fg(pattern, {
    cwd: changeDirectory,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    unique: true,
  })).sort();
  for (const output of outputs) await safeResolve(changeDirectory, output);
  return outputs;
}

async function approvalGranted(changeDirectory: string, outputs: string[]): Promise<boolean> {
  if (outputs.length === 0) return false;
  const content = await readFile(await safeResolve(changeDirectory, outputs[0]!), 'utf8');
  const approved = /(?:^|\n)\s*(?:[-*]\s*)?Status:\s*(?:approved|granted)\s*(?:\n|$)/i.test(content);
  const approver = /(?:^|\n)\s*(?:[-*]\s*)?Approver:\s*\S.+(?:\n|$)/i.test(content);
  const timestamp = /(?:^|\n)\s*(?:[-*]\s*)?Decision timestamp:\s*\d{4}-\d{2}-\d{2}T\S+(?:\n|$)/i.test(content);
  return approved && approver && timestamp;
}

export async function resolveChangeState(
  project: ProjectContext,
  changeId: string,
  knownFlows?: Map<string, Flow>,
): Promise<{ state: ChangeState; flow: Flow; config: ChangeConfig; changeDirectory: string; diagnostics: Diagnostic[] }> {
  assertResourceId(changeId, project.changesPath);
  const changeRelative = `${project.changesPath}/${changeId}`;
  const changeDirectory = await safeResolve(project.root, changeRelative);
  if (!await pathExists(changeDirectory)) {
    throw new XForgeError(diagnostic('XFORGE_CHANGE_NOT_FOUND', `Active Change not found: ${changeId}`, changeRelative), { root: project.root });
  }
  const configPath = path.join(changeDirectory, 'change.yaml');
  const config = await loadYaml<ChangeConfig>(configPath, `${changeRelative}/change.yaml`);
  const diagnostics = await validateSchema('change', config, `${changeRelative}/change.yaml`);
  const flowName = config.flow || project.manifest.flow;
  if (!flowName) diagnostics.push(diagnostic('XFORGE_FLOW_REQUIRED', 'Change or Manifest must select a Flow.', `${changeRelative}/change.yaml`));

  const flowsResult = knownFlows ? { flows: knownFlows, diagnostics: [] } : await loadFlows(project);
  diagnostics.push(...flowsResult.diagnostics);
  const flow = flowsResult.flows.get(flowName);
  if (!flow) {
    throw new XForgeError([
      ...diagnostics,
      diagnostic('XFORGE_FLOW_NOT_FOUND', `Selected Flow does not exist: ${flowName}`, `${changeRelative}/change.yaml`),
    ], { root: project.root });
  }

  const artifactStates: ArtifactState[] = [];
  const completed = new Set<string>();
  const rawOutputs = new Map<string, string[]>();
  for (const artifact of flow.artifacts) {
    const outputs = await artifactOutputs(changeDirectory, artifact);
    rawOutputs.set(artifact.id, outputs);
    let done = outputs.length > 0;
    if (artifact.id === 'approval' && done) done = await approvalGranted(changeDirectory, outputs);
    if (done) completed.add(artifact.id);
  }
  for (const artifact of flow.artifacts) {
    const missingDependencies = artifact.requires.filter((id) => !completed.has(id));
    const status: ArtifactState['status'] = completed.has(artifact.id)
      ? 'done'
      : missingDependencies.length === 0 ? 'ready' : 'blocked';
    artifactStates.push({ ...artifact, status, outputPaths: rawOutputs.get(artifact.id) ?? [], missingDependencies });
  }

  const applyReady = flow.operations.apply.requires.every((id) => completed.has(id));
  const archiveReady = flow.operations.archive.requires.every((id) => completed.has(id));
  const state: ChangeState = {
    id: changeId,
    path: toProjectPath(project.root, changeDirectory),
    flow: flow.metadata.name,
    classification: config.classification,
    scope: config.scope,
    artifacts: artifactStates,
    nextArtifact: artifactStates.find((item) => item.status === 'ready') ?? null,
    apply: { ready: applyReady, requires: flow.operations.apply.requires, tracks: flow.operations.apply.tracks },
    archive: {
      ready: archiveReady,
      requires: flow.operations.archive.requires,
      mandatoryGates: flow.operations.archive.mandatoryGates,
      syncSpecs: flow.operations.archive.syncSpecs,
    },
    workPackages: null,
  };
  return { state, flow, config, changeDirectory, diagnostics };
}
