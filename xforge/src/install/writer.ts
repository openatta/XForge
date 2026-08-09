import { readFile, rm } from 'node:fs/promises';
import type { FileChange, ProjectContext } from '../types.js';
import { atomicWrite } from '../core/files.js';
import { safeResolve } from '../core/path-safety.js';
import type { InstallPlan } from './planner.js';
import { OWNERSHIP_PATH } from './ownership.js';

interface Backup {
  path: string;
  content: Buffer | null;
}

async function backup(project: Pick<ProjectContext, 'root'>, relative: string): Promise<Backup> {
  try { return { path: relative, content: await readFile(await safeResolve(project.root, relative)) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: relative, content: null };
    throw error;
  }
}

async function restore(project: Pick<ProjectContext, 'root'>, items: Backup[]): Promise<void> {
  for (const item of [...items].reverse()) {
    if (item.content === null) await rm(await safeResolve(project.root, item.path), { force: true });
    else await atomicWrite(project.root, item.path, item.content);
  }
}

export async function applyInstallPlan(
  project: ProjectContext,
  plan: InstallPlan,
  lockContent: string,
  options: { writeOwnership: boolean; writeLock: boolean },
): Promise<void> {
  const actionable = plan.changes.filter((item) => ['create', 'modify', 'delete'].includes(item.action));
  const writes = new Map<string, string | Buffer | null>();
  for (const change of actionable) {
    if (change.action === 'delete') writes.set(change.path, null);
    else {
      const desired = plan.desired.get(change.path);
      if (!desired) throw new Error(`Desired content missing for ${change.path}`);
      writes.set(change.path, desired.content);
    }
  }
  if (options.writeOwnership) writes.set(OWNERSHIP_PATH, `${JSON.stringify(plan.next, null, 2)}\n`);
  if (options.writeLock) writes.set('xforge/lock.yaml', lockContent);
  await applyManagedTransaction(project, writes);
}

export async function applyManagedTransaction(
  project: Pick<ProjectContext, 'root'>,
  writes: Map<string, string | Buffer | null>,
): Promise<void> {
  const backupPaths = [...writes.keys()];
  const backups: Backup[] = [];
  try {
    for (const relative of backupPaths) backups.push(await backup(project, relative));
    for (const [relative, content] of writes) {
      if (content === null) await rm(await safeResolve(project.root, relative), { force: false });
      else await atomicWrite(project.root, relative, content);
    }
  } catch (error) {
    await restore(project, backups);
    throw error;
  }
}

export function actionableChanges(changes: FileChange[]): FileChange[] {
  return changes.filter((item) => item.action !== 'skip');
}
