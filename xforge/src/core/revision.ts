import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChangeState, GovernanceRevision, ProjectContext, StageFlow } from '../types.js';
import type { SelectedResources } from './resource-loader.js';
import { sha256, stableStringify } from './hash.js';
import { safeResolve } from './path-safety.js';

async function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', root, ...args], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve('unknown'));
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks).toString('utf8').trim() || 'unknown' : 'unknown'));
  });
}

export async function gitRevisions(root: string): Promise<{ base: string; head: string }> {
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (head === 'unknown') return { base: 'unknown', head };
  const base = await git(root, ['rev-parse', 'HEAD^']);
  return { base: base === 'unknown' ? head : base, head };
}

async function digestFile(project: ProjectContext, relative: string): Promise<{ path: string; digest: string }> {
  const content = await readFile(await safeResolve(project.root, relative));
  return { path: relative, digest: sha256(content) };
}

async function digestPaths(project: ProjectContext, relatives: Iterable<string>): Promise<Array<{ path: string; digest: string }>> {
  const inputs: Array<{ path: string; digest: string }> = [];
  for (const relative of [...relatives].sort()) inputs.push(await digestFile(project, relative));
  return inputs;
}

/**
 * The Artifact outputs that a Stage's approval is allowed to speak for: everything produced up to
 * and including that Stage. A later Stage writing its own Evidence therefore cannot invalidate an
 * approval that was given earlier, while editing anything the approver actually read still does.
 * An unknown Stage (`ready-to-archive`, legacy) covers the whole Change.
 */
function governingArtifactPaths(flow: StageFlow, state: ChangeState, stageId: string): string[] {
  const stageIndex = flow.stages.findIndex((stage) => stage.id === stageId);
  const artifactIds = stageIndex < 0
    ? null
    : new Set(flow.stages.slice(0, stageIndex + 1).flatMap((stage) => stage.produces ?? []));
  const paths: string[] = [];
  for (const artifact of state.artifacts) {
    if (artifactIds && !artifactIds.has(artifact.id)) continue;
    paths.push(...artifact.outputPaths);
  }
  return paths;
}

/**
 * The paths whose bytes a Change's content revision stands for: its config, its Flow, its Artifacts.
 */
async function contentInputPaths(project: ProjectContext, changeId: string, flow: StageFlow, state: ChangeState): Promise<Set<string>> {
  const changeRoot = `${project.changesPath}/${changeId}`;
  const paths = new Set<string>([`${changeRoot}/change.yaml`, `xforge/flows/${flow.metadata.name}.yaml`]);
  for (const artifact of state.artifacts) for (const output of artifact.outputPaths) paths.add(`${changeRoot}/${output}`);
  return paths;
}

/** The content revision formula, in one place, so nothing can compute it two ways. */
function contentRevisionOf(changeId: string, flowName: string, inputs: Array<{ path: string; digest: string }>, policySnapshotDigest: string): string {
  return sha256(stableStringify({ change: changeId, flow: flowName, inputs, policySnapshotDigest }));
}

/**
 * The content revision this Change would have if the policy snapshot were `policySnapshotDigest`.
 *
 * Answers the one question a stale closing receipt cannot answer for itself: the policy snapshot is
 * an input to the content revision, so a receipt whose `contentRevision` no longer matches may have
 * gone stale because a Rule moved, because an Artifact was edited, or because both happened. Re-run
 * the formula over today's bytes with the receipt's own policy digest: matching the receipt proves
 * the Artifacts are untouched and the policy alone moved. Anything else means the Artifacts moved
 * too, and the remedy that says "put the governing resource back" would leave the block in place.
 *
 * Deliberately not a stored field. Nothing new is written to a receipt, nothing existing is
 * restated, and the answer is available for receipts that were signed long before this existed.
 */
export async function contentRevisionUnderPolicy(
  project: ProjectContext,
  changeId: string,
  flow: StageFlow,
  state: ChangeState,
  policySnapshotDigest: string,
): Promise<string> {
  const inputs = await digestPaths(project, await contentInputPaths(project, changeId, flow, state));
  return contentRevisionOf(changeId, flow.metadata.name, inputs, policySnapshotDigest);
}

export async function computeGovernanceRevision(
  project: ProjectContext,
  changeId: string,
  flow: StageFlow,
  state: ChangeState,
  resources: SelectedResources,
  currentStage: string,
  transitionHead: string | null,
): Promise<GovernanceRevision> {
  const changeRoot = `${project.changesPath}/${changeId}`;
  const flowPath = `xforge/flows/${flow.metadata.name}.yaml`;
  const inputs = await digestPaths(project, await contentInputPaths(project, changeId, flow, state));

  const policySnapshotDigest = sha256(stableStringify({
    constitution: { version: project.constitution.version, digest: sha256(project.constitution.content) },
    flow,
    rules: [...resources.rules.values()].map((item) => item.value),
    policies: [...resources.policies.values()].map((item) => item.value),
    hooks: [...resources.hooks.values()].map((item) => item.value),
    gates: [...resources.gates.values()].map((item) => item.value),
  }));
  const revisions = await gitRevisions(project.root);
  /*
   * `gitHead` is audit metadata, not an equivalence input. Folding it in here meant that any commit
   * -- including committing the Evidence a Gate had just produced -- invalidated every Gate result
   * and every Approval for the Change, which is incompatible with a Git-native workflow.
   */
  const contentRevision = contentRevisionOf(changeId, flow.metadata.name, inputs, policySnapshotDigest);
  const stateRevision = sha256(stableStringify({ contentRevision, currentStage, transitionHead }));

  const governingInputs = await digestPaths(project, new Set<string>([
    `${changeRoot}/change.yaml`,
    flowPath,
    ...governingArtifactPaths(flow, state, currentStage).map((output) => `${changeRoot}/${output}`),
  ]));
  const governingRevision = sha256(stableStringify({
    change: changeId, flow: flow.metadata.name, stage: currentStage, inputs: governingInputs, policySnapshotDigest,
  }));

  return { contentRevision, stateRevision, policySnapshotDigest, gitBase: revisions.base, gitHead: revisions.head, governingRevision };
}

/** Git authors (email and name) of the commits in `base..head`, lowercased. */
export async function commitAuthors(root: string, range: string[]): Promise<string[]> {
  const output = await git(root, ['log', '--no-merges', '--format=%ae%n%an', ...range]);
  if (output === 'unknown') return [];
  return output.split('\n').map((line) => line.trim().toLowerCase()).filter((line) => line.length > 0);
}

/**
 * Who did the work on this Change, as committed facts only: the Git authors of the Change directory
 * and of every work-package delivery range. Deliberately excludes audit-event and transition-receipt
 * actors -- those record who ran a CLI command, not who implemented the Change, and they are absent
 * on a fresh clone where the committed evidence still is not.
 */
export async function changeImplementers(
  project: ProjectContext,
  changeId: string,
  state: ChangeState,
): Promise<Set<string>> {
  const implementers = new Set<string>();
  const changeDirectory = path.posix.join(project.changesPath, changeId);
  for (const author of await commitAuthors(project.root, ['--', changeDirectory])) implementers.add(author);
  for (const workPackage of state.workPackages?.packages ?? []) {
    const delivery = workPackage.delivery;
    if (!delivery?.base_commit || !delivery.head_commit) continue;
    for (const author of await commitAuthors(project.root, [`${delivery.base_commit}..${delivery.head_commit}`])) implementers.add(author);
  }
  return implementers;
}
