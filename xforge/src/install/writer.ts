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

async function backup(project: ProjectContext, relative: string): Promise<Backup> {
  try { return { path: relative, content: await readFile(await safeResolve(project.root, relative)) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: relative, content: null };
    throw error;
  }
}

async function restore(project: ProjectContext, items: Backup[]): Promise<void> {
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
  const backupPaths = [...new Set([
    ...actionable.map((item) => item.path),
    ...(options.writeOwnership ? [OWNERSHIP_PATH] : []),
    ...(options.writeLock ? ['xforge/lock.yaml'] : []),
  ])];
  const backups: Backup[] = [];
  try {
    for (const relative of backupPaths) backups.push(await backup(project, relative));
    for (const change of actionable) {
      if (change.action === 'delete') {
        await rm(await safeResolve(project.root, change.path), { force: false });
        continue;
      }
      const desired = plan.desired.get(change.path);
      if (!desired) throw new Error(`Desired content missing for ${change.path}`);
      await atomicWrite(project.root, change.path, desired.content);
    }
    if (options.writeOwnership) await atomicWrite(project.root, OWNERSHIP_PATH, `${JSON.stringify(plan.next, null, 2)}\n`);
    if (options.writeLock) await atomicWrite(project.root, 'xforge/lock.yaml', lockContent);
  } catch (error) {
    await restore(project, backups);
    throw error;
  }
}

export function actionableChanges(changes: FileChange[]): FileChange[] {
  return changes.filter((item) => item.action !== 'skip');
}
