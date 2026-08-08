import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { executeCheck } from '../commands/check.js';
import { checkStructure } from './checker.js';
import { XForgeError, diagnostic } from './errors.js';
import { atomicWrite } from './files.js';
import { assertManaged } from './project-loader.js';
import { safeResolve } from './path-safety.js';
import { planSpecMutations, type SpecMutation } from './spec-merger.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
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

export interface ArchivePlan {
  changeId: string;
  target: string;
  mutations: SpecMutation[];
  changes: FileChange[];
  diagnostics: Diagnostic[];
  mandatoryGates: string[];
}

export async function planArchive(project: ProjectContext, changeId: string): Promise<ArchivePlan> {
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
    const tracker = structure.change.apply.tracks;
    if (tracker) {
      const tasks = await incompleteTasks(project, changeId, tracker);
      if (tasks.length > 0) diagnostics.push(diagnostic('XFORGE_ARCHIVE_TASKS_INCOMPLETE', `${tasks.length} task(s) are incomplete.`, `${project.changesPath}/${changeId}/${tracker}`, 'error', tasks));
    }
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

interface Backup { path: string; content: Buffer | null }

async function backup(project: ProjectContext, relative: string): Promise<Backup> {
  try { return { path: relative, content: await readFile(await safeResolve(project.root, relative)) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: relative, content: null };
    throw error;
  }
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
  let plan = await planArchive(project, changeId);
  if (plan.diagnostics.some((item) => item.severity === 'error') || dryRun) {
    return {
      data: { change: changeId, target: plan.target, dryRun, mandatoryGates: plan.mandatoryGates, specs: plan.mutations.map((item) => item.path) },
      diagnostics: plan.diagnostics,
      changes: plan.changes,
    };
  }

  const checked = await executeCheck(project, { change: changeId });
  const diagnostics = [...checked.diagnostics];
  if (diagnostics.some((item) => item.severity === 'error')) {
    return {
      data: { change: changeId, target: plan.target, dryRun: false, mandatoryGates: plan.mandatoryGates, specs: plan.mutations.map((item) => item.path) },
      diagnostics,
      changes: checked.changes,
    };
  }

  plan = await planArchive(project, changeId);
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
  return {
    data: { change: changeId, target: plan.target, dryRun: false, mandatoryGates: plan.mandatoryGates, specs: plan.mutations.map((item) => item.path) },
    diagnostics,
    changes: [...checked.changes, ...plan.changes],
  };
}
