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
  StageFlow,
} from '../types.js';
import { XForgeError, diagnostic } from './errors.js';
import { assertResourceId, normalizeRelative, safeResolve, toProjectPath } from './path-safety.js';
import { contractDeltaIsValid, isContractDeltaArtifact } from './contract-delta.js';
import { isSpecDeltaArtifact, specDeltaIsValid } from './spec-delta.js';
import { validateSchema } from './validator.js';
import { loadYaml } from './yaml.js';

async function pathExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

export function isStageFlow(flow: Flow): flow is StageFlow {
  return flow.apiVersion === 'xforge.dev/v1alpha2';
}

function transitiveStageIds(flow: StageFlow, ids: string[]): Set<string> {
  const byId = new Map(flow.stages.map((stage) => [stage.id, stage]));
  const result = new Set<string>();
  const visit = (id: string): void => {
    if (result.has(id)) return;
    result.add(id);
    for (const dependency of byId.get(id)?.requires ?? []) visit(dependency);
  };
  for (const id of ids) visit(id);
  return result;
}

function artifactsForStages(flow: StageFlow, stageIds: string[], transitive = false): string[] {
  const selected = transitive ? transitiveStageIds(flow, stageIds) : new Set(stageIds);
  return flow.stages.flatMap((stage) => selected.has(stage.id) ? stage.produces : []);
}

export function flowArtifacts(flow: Flow): ArtifactDefinition[] {
  if (!isStageFlow(flow)) return flow.artifacts;
  const definitions = new Map(flow.artifacts.map((artifact) => [artifact.id, artifact]));
  const result: ArtifactDefinition[] = [];
  for (const stage of flow.stages) {
    const dependencies = artifactsForStages(flow, stage.requires, true);
    const earlierInStage: string[] = [];
    for (const id of stage.produces) {
      const definition = definitions.get(id);
      if (!definition) continue;
      result.push({ ...definition, requires: [...new Set([...dependencies, ...earlierInStage])] });
      earlierInStage.push(id);
    }
  }
  return result;
}

function flowPlanningArtifactIds(flow: Flow): Set<string> {
  if (!isStageFlow(flow)) return new Set(flow.artifacts.map((artifact) => artifact.id));
  const applyIndex = flow.stages.findIndex((stage) => stage.id === 'apply');
  return new Set(flow.stages
    .filter((_stage, index) => applyIndex < 0 || index < applyIndex)
    .flatMap((stage) => stage.produces));
}

/**
 * `tracks` is legacy-only and stays in the shape on purpose.
 *
 * It names a v1alpha1 Flow's task-tracker file, which `core/archiver.ts` still reads behind an
 * `if (tracker)` to refuse an archive with tasks left open. A Stage Flow has no such file — Stages
 * carry that meaning now — so it is null there, and null is the value `archiver` reads as "this
 * Flow does not track tasks". Dropping the key rather than nulling it would change the documented
 * `xforge state` shape (`docs/concepts-and-architecture.md` prints `apply: { ready, requires,
 * tracks }`) for the v1alpha1 Flows that still populate it. It goes when v1alpha1 goes, not before.
 */
export function flowApplyOperation(flow: Flow): { requires: string[]; tracks: string | null } {
  if (!isStageFlow(flow)) return flow.operations.apply;
  const apply = flow.stages.find((stage) => stage.id === 'apply');
  return { requires: apply ? artifactsForStages(flow, apply.requires) : [], tracks: null };
}

export function flowArchiveOperation(flow: Flow): {
  requires: string[];
  syncSpecs: boolean;
  syncContracts: boolean;
  mandatoryGates: string[];
} {
  /* `syncContracts` is optional in both schemas, so a Flow written before contracts existed reads
     as false here rather than as undefined -- archive branches on it directly. */
  if (!isStageFlow(flow)) return { ...flow.operations.archive, syncContracts: flow.operations.archive.syncContracts ?? false };
  /*
   * Declared if the Flow says so, inferred from the Stage named `verify` if it does not.
   *
   * v1alpha1 required this set as `mandatoryGates`; v1alpha2 dropped the field and inferred it
   * here, which is correct for every shipped Flow and silent when it is wrong. A Flow with a Stage
   * after Verify contributes none of that Stage's Gates to the archive re-check and gets no
   * diagnostic -- the Gates simply are not in the set. `graphDiagnostics` reports that case now;
   * this reads the declaration when there is one and keeps the inference when there is not, so no
   * existing Flow changes behaviour.
   */
  const verify = flow.stages.find((stage) => stage.id === 'verify');
  return {
    requires: artifactsForStages(flow, flow.terminal.archive.requires),
    syncSpecs: flow.terminal.archive.syncSpecs,
    syncContracts: flow.terminal.archive.syncContracts ?? false,
    mandatoryGates: [...new Set(flow.terminal.archive.gates ?? verify?.gates ?? [])],
  };
}

/**
 * Every Gate a Stage names, paired with the Stage naming it.
 *
 * `flowArchiveOperation().mandatoryGates` answers a different question -- which Gates archive
 * demands -- and its answer is the verify Stage's `gates` alone. Validating a Flow's Gate
 * references against that list checks one Stage out of however many the Flow has, so a Gate named
 * at propose, design or check was never checked to exist at all: `doctor` reported `dangling: 0`,
 * `xforge check` passed, `transition` passed, and the Flow failed only once a Stage actually
 * reached the Gate, with XFORGE_GATE_NOT_FOUND and no earlier warning of any kind.
 */
export function stageGateReferences(flow: StageFlow): Array<{ stage: string; gate: string }> {
  return flow.stages.flatMap((stage) =>
    [...new Set([...(stage.gates ?? []), ...(stage.exit?.gates ?? [])])].map((gate) => ({ stage: stage.id, gate })),
  );
}

/** The keys that make a stage `exit` legible to the control plane. Mirrors `structuredExit`. */
const STRUCTURED_EXIT_KEYS = ['conditions', 'gates', 'approvals', 'auditEvents'] as const;

function stageGraphDiagnostics(flow: StageFlow, filePath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const artifactIds = flow.artifacts.map((item) => item.id);
  const stageIds = flow.stages.map((item) => item.id);
  const artifactSet = new Set(artifactIds);
  const stageSet = new Set(stageIds);
  if (artifactSet.size !== artifactIds.length) {
    diagnostics.push(diagnostic('XFORGE_FLOW_ARTIFACT_DUPLICATE', 'Flow Artifact IDs must be unique.', filePath));
  }
  if (stageSet.size !== stageIds.length) {
    diagnostics.push(diagnostic('XFORGE_FLOW_STAGE_DUPLICATE', 'Flow Stage IDs must be unique.', filePath));
  }
  const producedCounts = new Map<string, number>();
  for (const id of flow.stages.flatMap((stage) => stage.produces)) {
    producedCounts.set(id, (producedCounts.get(id) ?? 0) + 1);
  }
  for (const artifact of flow.artifacts) {
    try { normalizeRelative(artifact.generates, `Artifact ${artifact.id} output`); } catch (error) {
      if (error instanceof XForgeError) diagnostics.push(...error.diagnostics);
    }
    const producerCount = producedCounts.get(artifact.id) ?? 0;
    if (producerCount === 0) diagnostics.push(diagnostic('XFORGE_FLOW_ARTIFACT_UNPRODUCED', `Artifact ${artifact.id} is not produced by any Stage.`, filePath));
    if (producerCount > 1) diagnostics.push(diagnostic('XFORGE_FLOW_ARTIFACT_MULTIPLE_PRODUCERS', `Artifact ${artifact.id} is produced by more than one Stage.`, filePath));
  }
  for (const stage of flow.stages) {
    for (const artifact of [...stage.produces, ...(stage.revises ?? [])]) {
      if (!artifactSet.has(artifact)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_ARTIFACT_REFERENCE_UNKNOWN', `Stage ${stage.id} references unknown Artifact ${artifact}.`, filePath));
      }
    }
    /*
     * A stage `exit` in the pre-structured shape validates and then governs nothing.
     *
     * `flow.schema.json` still accepts a bare map of `<key>: <expected>` — the form `exit` had
     * before `conditions`/`gates`/`approvals`/`auditEvents` were introduced — and every reader
     * since expects the structured one. `structuredExit` (core/control-plane.ts) returns `{}` for
     * anything without one of those four keys, `commands/check.ts` and `commands/doctor.ts` read
     * `exit.gates` and `exit.approvals` and find nothing, and `commands/approve.ts` finds no policy
     * to bind a receipt to. So a project that writes `exit: {materialQuestions: resolved}` in its
     * own Flow gets a clean validation, no doctor finding, and a door the control plane never
     * looks at — the same shape as a condition that never appears in `blockedBy`, which is
     * indistinguishable from one that does not exist.
     *
     * The schema is deliberately left permissive so the file still loads and this can say which
     * Stage and what to write instead; an `anyOf` rejection here would print that it matched no
     * branch and stop.
     */
    if (stage.exit && !STRUCTURED_EXIT_KEYS.some((key) => key in (stage.exit as Record<string, unknown>))) {
      diagnostics.push(diagnostic(
        'XFORGE_FLOW_EXIT_UNSTRUCTURED',
        `Stage ${stage.id} declares an exit with none of ${STRUCTURED_EXIT_KEYS.join(', ')}, which no part of the control plane reads — the Stage would exit as though it declared nothing. Wrap the entries under the key that says what they are, for example \`exit: { conditions: { ${Object.keys(stage.exit as Record<string, unknown>)[0] ?? '<key>'}: <expected> } }\`.`,
        filePath,
      ));
    }
    for (const dependency of [...stage.requires, ...(stage.reworkTo ?? [])]) {
      if (!stageSet.has(dependency)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_STAGE_REFERENCE_UNKNOWN', `Stage ${stage.id} references unknown Stage ${dependency}.`, filePath));
      }
      if (dependency === stage.id && stage.requires.includes(dependency)) {
        diagnostics.push(diagnostic('XFORGE_FLOW_DEPENDENCY_CYCLE', `Stage ${stage.id} requires itself.`, filePath));
      }
    }
    /*
     * A `requires` pointing at a Stage that comes later, which the cycle check cannot see.
     *
     * `A requires B` where B sits further down `stages` is perfectly acyclic, so the DFS above walks
     * it and says nothing. But a Change moves through `stages` in array order — `legalTransitionTargets`
     * offers the next index plus `reworkTo` and nothing else — so B has not run when A is reached and
     * never will have. `flowArtifacts` then hands every Artifact A produces a dependency on B's
     * output, and those Artifacts sit at `blocked` for the life of the Change: `nextArtifact` skips
     * them, `apply.artifactsReady` cannot become true, and no Gate, condition or approval is involved in any
     * of it. The Flow author sees a Change that stops advancing and no diagnostic anywhere, because
     * every check that exists is satisfied. This is the one that says which way the arrow points.
     */
    const stageIndex = stageIds.indexOf(stage.id);
    for (const dependency of stage.requires) {
      const dependencyIndex = stageIds.indexOf(dependency);
      if (dependencyIndex > stageIndex) {
        diagnostics.push(diagnostic(
          'XFORGE_FLOW_STAGE_FORWARD_DEPENDENCY',
          `Stage ${stage.id} requires Stage ${dependency}, which comes after it. A Change walks ${filePath.split('/').pop()}'s Stages in the order they are listed, so ${dependency} cannot have run by the time ${stage.id} is reached, and every Artifact ${stage.id} produces stays blocked on an output that never arrives. Either move ${dependency} before ${stage.id}, or say the relationship with \`reworkTo\` if what was meant is that ${stage.id} can be returned to.`,
          filePath,
        ));
      }
    }
  }
  for (const required of flow.terminal.archive.requires) {
    if (!stageSet.has(required)) diagnostics.push(diagnostic('XFORGE_FLOW_TERMINAL_REFERENCE_UNKNOWN', `Archive requires unknown Stage ${required}.`, filePath));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(flow.stages.map((item) => [item.id, item]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      diagnostics.push(diagnostic('XFORGE_FLOW_DEPENDENCY_CYCLE', `Flow contains a Stage dependency cycle at ${id}.`, filePath));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.requires ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of stageIds) visit(id);
  for (const required of ['propose', 'apply', 'verify']) {
    if (!stageSet.has(required)) diagnostics.push(diagnostic('XFORGE_FLOW_STAGE_REQUIRED', `Stage Flow must define ${required}.`, filePath));
  }
  /*
   * A Stage after Verify whose Gates archive will not re-run.
   *
   * The archive-mandatory Gate set is the Gates of the Stage named `verify` unless
   * `terminal.archive.gates` says otherwise, so a Flow that adds a Stage after Verify silently
   * contributes none of that Stage's Gates to the archive re-check. It is not an error -- a Flow may
   * legitimately want only Verify's Gates re-run -- but it must be a decision somebody made rather
   * than a consequence of where the inference happens to look.
   */
  if (flow.terminal.archive.gates === undefined) {
    const verifyIndex = flow.stages.findIndex((stage) => stage.id === 'verify');
    const after = verifyIndex >= 0 ? flow.stages.slice(verifyIndex + 1).filter((stage) => (stage.gates ?? []).length > 0) : [];
    if (after.length > 0) {
      diagnostics.push(diagnostic(
        'XFORGE_FLOW_ARCHIVE_GATES_INFERRED',
        `Stage${after.length === 1 ? '' : 's'} ${after.map((stage) => stage.id).join(', ')} run after verify and declare Gates that archive will not re-run: with no \`terminal.archive.gates\`, the archive-mandatory set is verify's Gates alone. State the set explicitly, or confirm by declaring it as verify's.`,
        filePath,
        'warning',
      ));
    }
  }
  return diagnostics;
}

function legacyGraphDiagnostics(flow: Exclude<Flow, StageFlow>, filePath: string): Diagnostic[] {
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
      if (!unique.has(dependency)) diagnostics.push(diagnostic('XFORGE_FLOW_DEPENDENCY_UNKNOWN', `Artifact ${artifact.id} requires unknown Artifact ${dependency}.`, filePath));
      if (dependency === artifact.id) diagnostics.push(diagnostic('XFORGE_FLOW_DEPENDENCY_CYCLE', `Artifact ${artifact.id} requires itself.`, filePath));
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

function graphDiagnostics(flow: Flow, filePath: string): Diagnostic[] {
  return isStageFlow(flow) ? stageGraphDiagnostics(flow, filePath) : legacyGraphDiagnostics(flow, filePath);
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
    const schemaDiagnostics = await validateSchema('flow', flow, relative);
    diagnostics.push(...schemaDiagnostics);
    if (flow.metadata?.name) {
      if (flow.metadata.name !== name.slice(0, -5)) diagnostics.push(diagnostic('XFORGE_FLOW_FILENAME_MISMATCH', 'Flow metadata.name must match its filename.', relative));
      if (flows.has(flow.metadata.name)) diagnostics.push(diagnostic('XFORGE_FLOW_DUPLICATE', `Duplicate Flow ${flow.metadata.name}.`, relative));
      flows.set(flow.metadata.name, flow);
      if (!schemaDiagnostics.some((item) => item.severity === 'error')) diagnostics.push(...graphDiagnostics(flow, relative));
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

/**
 * An Artifact counts as produced only when every output it generated carries content. A
 * placeholder or truncated write is an unfinished Artifact, not a completed one, and a delta
 * Spec must additionally parse as a valid requirement delta before it satisfies its Artifact.
 */
async function outputsSatisfyArtifact(
  changeDirectory: string,
  artifact: ArtifactDefinition,
  outputs: string[],
): Promise<boolean> {
  if (outputs.length === 0) return false;
  const validateDelta = isSpecDeltaArtifact(artifact);
  /* Never both: `isContractDeltaArtifact` defers to an explicit `validator`, and by convention the
     two live under different subtrees, so an Artifact answers to one validator or to neither. */
  const validateContract = isContractDeltaArtifact(artifact);
  for (const output of outputs) {
    let content: string;
    try {
      content = await readFile(await safeResolve(changeDirectory, output), 'utf8');
    } catch {
      return false;
    }
    if (content.trim().length === 0) return false;
    if (validateDelta && !specDeltaIsValid(content)) return false;
    if (validateContract && !contractDeltaIsValid(content)) return false;
  }
  return true;
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
  if (diagnostics.some((item) => item.severity === 'error')) {
    throw new XForgeError(diagnostics, { root: project.root });
  }
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

  const artifacts = flowArtifacts(flow);
  const artifactStates: ArtifactState[] = [];
  const completed = new Set<string>();
  const rawOutputs = new Map<string, string[]>();
  for (const artifact of artifacts) {
    const outputs = await artifactOutputs(changeDirectory, artifact);
    rawOutputs.set(artifact.id, outputs);
    let done = await outputsSatisfyArtifact(changeDirectory, artifact, outputs);
    if (!isStageFlow(flow) && artifact.id === 'approval' && done) done = await approvalGranted(changeDirectory, outputs);
    if (done) completed.add(artifact.id);
  }
  for (const artifact of artifacts) {
    const missingDependencies = artifact.requires.filter((id) => !completed.has(id));
    const status: ArtifactState['status'] = completed.has(artifact.id)
      ? 'done'
      : missingDependencies.length === 0 ? 'ready' : 'blocked';
    artifactStates.push({
      ...artifact,
      status,
      outputPaths: rawOutputs.get(artifact.id) ?? [],
      writePath: `${changeRelative}/${normalizeRelative(artifact.generates, `Artifact ${artifact.id} output`)}`,
      missingDependencies,
    });
  }

  const apply = flowApplyOperation(flow);
  const archive = flowArchiveOperation(flow);
  const applyReady = apply.requires.every((id) => completed.has(id));
  const archiveReady = archive.requires.every((id) => completed.has(id));
  const planningIds = flowPlanningArtifactIds(flow);
  const state: ChangeState = {
    id: changeId,
    path: toProjectPath(project.root, changeDirectory),
    flow: flow.metadata.name,
    /* Filled in where governance resolves; null for a Flow that declares no Stages. */
    stage: null,
    classification: config.classification,
    scope: config.scope,
    artifacts: artifactStates,
    nextArtifact: artifactStates.find((item) => planningIds.has(item.id) && item.status === 'ready') ?? null,
    /* `artifactsReady`, not `ready`: it answers whether the Artifacts this operation requires
       exist, and nothing about Gates, conditions or approvals. Three separate live runs read a bare
       `ready: true` beside a blocked `readyTransitions` entry as a contradiction; it was two
       questions sharing one word. */
    apply: { artifactsReady: applyReady, requires: apply.requires, tracks: apply.tracks },
    archive: {
      artifactsReady: archiveReady,
      requires: archive.requires,
      mandatoryGates: archive.mandatoryGates,
      syncSpecs: archive.syncSpecs,
      syncContracts: archive.syncContracts,
    },
    workPackages: null,
  };
  return { state, flow, config, changeDirectory, diagnostics };
}
