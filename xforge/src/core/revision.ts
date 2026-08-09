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
  const governingPaths = new Set<string>([`${changeRoot}/change.yaml`, `xforge/flows/${flow.metadata.name}.yaml`]);
  for (const artifact of state.artifacts) for (const output of artifact.outputPaths) governingPaths.add(`${changeRoot}/${output}`);
  const inputs = [];
  for (const relative of [...governingPaths].sort()) inputs.push(await digestFile(project, relative));

  const policySnapshotDigest = sha256(stableStringify({
    constitution: { version: project.constitution.version, digest: sha256(project.constitution.content) },
    flow,
    rules: [...resources.rules.values()].map((item) => item.value),
    policies: [...resources.policies.values()].map((item) => item.value),
    hooks: [...resources.hooks.values()].map((item) => item.value),
    gates: [...resources.gates.values()].map((item) => item.value),
  }));
  const revisions = await gitRevisions(project.root);
  const contentRevision = sha256(stableStringify({ change: changeId, flow: flow.metadata.name, inputs, policySnapshotDigest, gitHead: revisions.head }));
  const stateRevision = sha256(stableStringify({ contentRevision, currentStage, transitionHead }));
  return { contentRevision, stateRevision, policySnapshotDigest, gitBase: revisions.base, gitHead: revisions.head };
}
