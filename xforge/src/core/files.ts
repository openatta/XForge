import type { ProjectContext } from '../types.js';
import { randomUUID } from 'node:crypto';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeResolve } from './path-safety.js';

/**
 * Whether a path can be reached.
 *
 * Written independently in twelve modules before this, character for character, which is the kind
 * of duplication that costs nothing until the day one copy is changed. Note what it does *not*
 * answer: `access` follows symlinks, so a dangling one reads as absent. `commands/init.ts` keeps
 * its own `lstat`-based version for exactly that reason — it is asking whether a path is occupied,
 * and a broken symlink occupies it — and that difference is why these two must stay apart.
 */
export async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

/** A file's prior content, or `null` where there was none, for an unwind that must restore either. */
export interface Backup {
  path: string;
  content: Buffer | null;
}

/**
 * Reads a file for the purpose of putting it back.
 *
 * `null` for a path that did not exist is the whole point: an unwind has to be able to delete a
 * file it created as well as restore one it overwrote, and those are the same operation to a caller
 * that treats absence as a value rather than as an error.
 */
export async function backup(project: Pick<ProjectContext, 'root'>, relative: string): Promise<Backup> {
  try { return { path: relative, content: await readFile(await safeResolve(project.root, relative)) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: relative, content: null };
    throw error;
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicWrite(root: string, relative: string, content: string | Buffer): Promise<void> {
  const destination = await safeResolve(root, relative, { createParent: true });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.xforge-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
