import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { executeCheck } from '../commands/check.js';
import { checkStructure } from './checker.js';
import { XForgeError, diagnostic } from './errors.js';
import { atomicWrite, backup, exists } from './files.js';
import { assertManaged } from './project-loader.js';
import { safeResolve } from './path-safety.js';
import { planSpecMutations, type SpecMutation } from './spec-merger.js';
import { isStageFlow, resolveChangeState } from './flow-resolver.js';
import { contentRevisionUnderPolicy } from './revision.js';
import { loadSelectedResources, type SelectedResources } from './resource-loader.js';
import { blockRemedy, resolveControlPlane, terminalGovernanceBlocks } from './control-plane.js';
import { readChangeAuditEvents, recordAudit, type ChangeAuditFacts } from './audit.js';

/**
 * `git status --porcelain` over specific paths, or `null` when the question cannot be asked here.
 *
 * `null` covers every "we do not know" case — no Git on PATH, not a repository, a failed
 * invocation — and every caller treats it as "report nothing". Guessing that an unanswerable
 * question means "uncommitted" would block archives in environments that never had Git.
 */
async function gitPorcelain(root: string, paths: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
  });
}

function archiveName(changeId: string, now = new Date()): string {
  const localDate = [
    String(now.getFullYear()).padStart(4, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return /^\d{4}-\d{2}-\d{2}-/.test(changeId) ? changeId : `${localDate}-${changeId}`;
}

async function incompleteTasks(project: ProjectContext, changeId: string, tracks: string): Promise<string[]> {
  const relative = `${project.changesPath}/${changeId}/${tracks}`;
  const absolute = await safeResolve(project.root, relative);
  if (!await exists(absolute)) return [`Missing task tracker: ${tracks}`];
  const source = await readFile(absolute, 'utf8');
  return [...source.matchAll(/^\s*-\s*\[ \]\s+(.+)$/gmi)].map((match) => match[1]!.trim());
}

interface ArchivePlan {
  changeId: string;
  target: string;
  mutations: SpecMutation[];
  changes: FileChange[];
  diagnostics: Diagnostic[];
  mandatoryGates: string[];
}

interface PlanArchiveOptions {
  /**
   * Audit facts captured before `archive` recorded any event of its own. Archive appends
   * `archive.before` and Gate events to the Change's chain while it runs; on a machine that only
   * has the committed index (fresh clone, CI) those appends rebuild the index from a local chain
   * that starts empty, so the pre-archive facts must be carried through both planning passes.
   */
  auditFacts?: ChangeAuditFacts;
}

/**
 * Refuses to archive while the definition of a mandatory Gate is not in version control.
 *
 * The audit chain exists to make a conclusion reproducible. A live run hit exactly the case this
 * guards: the shipped Gates asserted nothing on a non-Node project, the fix was to edit them, and
 * editing them mid-Change invalidated every delivery — so the edited Gate files were left
 * uncommitted and the Change archived anyway. The chain then recorded "security-scan passed" while
 * the definition that produced that pass existed only in one working tree. Check the repository out
 * anywhere else and the same command yields a different answer, which means the record proves
 * nothing.
 *
 * Deliberately scoped to Gates the archive itself requires, and silent where the question cannot be
 * asked: no Git, or a project that is not a repository root, reports nothing rather than guessing.
 */
async function uncommittedGateDefinitions(
  project: ProjectContext,
  mandatoryGates: readonly string[],
  resources: SelectedResources,
): Promise<Diagnostic[]> {
  if (mandatoryGates.length === 0) return [];
  const paths = mandatoryGates
    .map((name) => resources.gates.get(name)?.yamlPath)
    .filter((item): item is string => Boolean(item));
  if (paths.length === 0) return [];

  const status = await gitPorcelain(project.root, paths);
  if (status === null) return [];
  const dirty = [...new Set(status.split('\0').filter((line) => line.length > 3).map((line) => line.slice(3)))];
  if (dirty.length === 0) return [];
  return [diagnostic(
    'XFORGE_ARCHIVE_GATE_DEFINITION_UNCOMMITTED',
    `The definition of ${dirty.length === 1 ? 'a mandatory Gate is' : 'mandatory Gates are'} not committed: ${dirty.join(', ')}. Archiving now records that these Gates passed while the files that decided it exist only in this working tree — another checkout would run different Gates and could reach a different conclusion. Commit them before archiving.`,
    dirty[0],
  )];
}

async function planArchive(project: ProjectContext, changeId: string, options: PlanArchiveOptions = {}): Promise<ArchivePlan> {
  assertManaged(project, 'archive');
  const structure = await checkStructure(project, changeId);
  const diagnostics = [...structure.diagnostics];
  if (diagnostics.some((item) => ['XFORGE_LOCK_SCAFFOLD_MISMATCH', 'XFORGE_LOCK_PATHS_MISMATCH', 'XFORGE_LOCK_RESOURCES_MISMATCH'].includes(item.code))) {
    diagnostics.push(diagnostic('XFORGE_LOCK_STALE', 'Run xforge install before archive so the lock matches current project inputs.', 'xforge/lock.yaml'));
  }
  if (!structure.change) diagnostics.push(diagnostic('XFORGE_CHANGE_NOT_FOUND', `Active Change not found: ${changeId}`));
  else {
    if (!structure.change.archive.ready) {
      const incomplete = structure.change.artifacts.filter((item) => structure.change!.archive.requires.includes(item.id) && item.status !== 'done').map((item) => item.id);
      diagnostics.push(diagnostic('XFORGE_ARCHIVE_ARTIFACTS_INCOMPLETE', `Archive prerequisites are incomplete: ${incomplete.join(', ')}`, `${project.changesPath}/${changeId}`));
    }
    const resolved = await resolveChangeState(project, changeId);
    if (isStageFlow(resolved.flow) && resolved.flow.governance) {
      const resources = await loadSelectedResources(project);
      /* The plan `checkStructure` already resolved above, handed over rather than read again. It is
         also what stops archive re-deciding `independentReview` against an empty package list: the
         resolve fills it in either way now, and passing it keeps this path to one read. */
      const control = await resolveControlPlane(project, changeId, resolved.flow, resolved.state, resources, resolved.config, { workPackages: structure.workPackages ?? undefined });
      diagnostics.push(...control.diagnostics);
      const governanceBlocks = await terminalGovernanceBlocks(project, control, { auditFacts: options.auditFacts });
      for (const block of governanceBlocks) diagnostics.push(diagnostic('XFORGE_ARCHIVE_GOVERNANCE_BLOCKED', `Archive governance is blocked by ${block}.`, `${project.changesPath}/${changeId}`));
      /* The receipt itself, not just the block string: the remedy has to name the revision the
         approver actually signed for, and `xforge state` reports several `contentRevision` values
         — one per historical receipt — so telling the reader to "find it" is how the wrong one
         gets picked. A live run did exactly that with `grep -m1`. */
      const ready = control.governance.transitions.at(-1);
      const readyReceipt = ready && ready.to === 'ready-to-archive'
        ? {
          receiptId: ready.receiptId, from: ready.from,
          contentRevision: ready.contentRevision, policySnapshotDigest: ready.policySnapshotDigest,
        }
        : undefined;
      /* Asked only where the answer is used: the remedy distinguishes a policy move from an Artifact
         edit, and the two can have happened together. Re-running the content formula under the
         receipt's own policy digest is the only way to tell, and it costs one extra pass over the
         Change's Artifact bytes on a path that is already reading them. */
      const artifactsMoved = readyReceipt
        ? await contentRevisionUnderPolicy(project, changeId, resolved.flow, control.state, readyReceipt.policySnapshotDigest) !== readyReceipt.contentRevision
        : false;
      const remedy = blockRemedy(governanceBlocks, changeId, {
        readyReceipt,
        current: {
          contentRevision: control.governance.revision.contentRevision,
          policySnapshotDigest: control.governance.revision.policySnapshotDigest,
          artifactsMoved,
        },
      });
      if (remedy) diagnostics.push(diagnostic(remedy.code, remedy.message, `${project.changesPath}/${changeId}`, 'info'));
    }
    const tracker = structure.change.apply.tracks;
    if (tracker) {
      const tasks = await incompleteTasks(project, changeId, tracker);
      if (tasks.length > 0) diagnostics.push(diagnostic('XFORGE_ARCHIVE_TASKS_INCOMPLETE', `${tasks.length} task(s) are incomplete.`, `${project.changesPath}/${changeId}/${tracker}`, 'error', tasks));
    }
    diagnostics.push(...await uncommittedGateDefinitions(project, structure.change.archive.mandatoryGates, structure.resources));
  }
  if (diagnostics.some((item) => item.severity === 'error')) {
    return { changeId, target: '', mutations: [], changes: [], diagnostics, mandatoryGates: structure.change?.archive.mandatoryGates ?? [] };
  }

  const targetName = archiveName(changeId);
  const target = `${project.changesPath}/archive/${targetName}`;
  if (await exists(await safeResolve(project.root, target))) diagnostics.push(diagnostic('XFORGE_ARCHIVE_TARGET_EXISTS', 'Archive target already exists.', target));
  const mutations = structure.change?.archive.syncSpecs ? await planSpecMutations(project, changeId) : [];
  const changes = [
    ...mutations.map((item) => item.change),
    { action: 'move' as const, from: `${project.changesPath}/${changeId}`, path: target, source: `change:${changeId}` },
  ];
  return { changeId, target, mutations, changes, diagnostics, mandatoryGates: structure.change?.archive.mandatoryGates ?? [] };
}

async function applyArchiveTransaction(project: ProjectContext, plan: ArchivePlan): Promise<void> {
  const backups = await Promise.all(plan.mutations.map((item) => backup(project, item.path)));
  const source = await safeResolve(project.root, `${project.changesPath}/${plan.changeId}`);
  const target = await safeResolve(project.root, plan.target);
  let moved = false;
  try {
    for (const mutation of plan.mutations) {
      if (mutation.content === null) await rm(await safeResolve(project.root, mutation.path), { force: false });
      else await atomicWrite(project.root, mutation.path, mutation.content);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await safeResolve(project.root, path.posix.dirname(plan.target));
    await rename(source, target);
    moved = true;
  } catch (error) {
    if (moved) await rename(target, source).catch(() => undefined);
    for (const item of backups.reverse()) {
      if (item.content === null) await rm(await safeResolve(project.root, item.path), { force: true }).catch(() => undefined);
      else await atomicWrite(project.root, item.path, item.content);
    }
    throw error;
  }
}

export async function executeArchive(project: ProjectContext, changeId: string, dryRun: boolean): Promise<{
  data: { change: string; target: string; dryRun: boolean; mandatoryGates: string[]; specs: string[] };
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  const auditFacts = await readChangeAuditEvents(project, changeId);
  let plan = await planArchive(project, changeId, { auditFacts });
  if (plan.diagnostics.some((item) => item.severity === 'error') || dryRun) {
    return {
      data: { change: changeId, target: plan.target, dryRun, mandatoryGates: plan.mandatoryGates, specs: plan.mutations.map((item) => item.path) },
      diagnostics: plan.diagnostics,
      changes: plan.changes,
    };
  }

  const auditResolved = await resolveChangeState(project, changeId);
  const auditResources = await loadSelectedResources(project);
  const auditControl = isStageFlow(auditResolved.flow) && auditResolved.flow.governance
    ? await resolveControlPlane(project, changeId, auditResolved.flow, auditResolved.state, auditResources, auditResolved.config)
    : null;
  await recordAudit(project, { eventType: 'archive.before', change: changeId, flow: auditResolved.flow.metadata.name, stage: auditControl?.governance.currentStage ?? 'legacy', revision: auditControl?.governance.revision, outcome: 'succeeded', input: { target: plan.target } });

  const checked = await executeCheck(project, { change: changeId });
  const diagnostics = [...checked.diagnostics];
  if (diagnostics.some((item) => item.severity === 'error')) {
    return {
      data: { change: changeId, target: plan.target, dryRun: false, mandatoryGates: plan.mandatoryGates, specs: plan.mutations.map((item) => item.path) },
      diagnostics,
      changes: checked.changes,
    };
  }

  plan = await planArchive(project, changeId, { auditFacts });
  if (plan.diagnostics.some((item) => item.severity === 'error')) {
    return {
      data: { change: changeId, target: plan.target, dryRun: false, mandatoryGates: plan.mandatoryGates, specs: [] },
      diagnostics: plan.diagnostics,
      changes: checked.changes,
    };
  }
  try {
    await applyArchiveTransaction(project, plan);
  } catch (error) {
    throw new XForgeError(diagnostic('XFORGE_ARCHIVE_TRANSACTION_FAILED', `Archive transaction failed and was rolled back: ${(error as Error).message}`, `${project.changesPath}/${changeId}`), { root: project.root });
  }
  await recordAudit(project, { eventType: 'archive.after', change: changeId, flow: auditResolved.flow.metadata.name, stage: 'archived', revision: auditControl?.governance.revision, outcome: 'succeeded', output: { target: plan.target } });
  return {
    data: { change: changeId, target: plan.target, dryRun: false, mandatoryGates: plan.mandatoryGates, specs: plan.mutations.map((item) => item.path) },
    diagnostics,
    changes: [...checked.changes, ...plan.changes],
  };
}
