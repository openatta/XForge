import { readdir } from 'node:fs/promises';
import type { ProjectContext } from '../types.js';
import { safeResolve } from './path-safety.js';

interface ChangeDirectoryListing {
  /** The Changes in flight: every directory that is not `archive` and not a dotfile. */
  ids: string[];
  /**
   * Why `ids` is empty, when it is empty for a reason other than there being none. `null` when the
   * directory was read — including when it does not exist, which is a real answer of "none".
   *
   * The errno (`ENOTDIR`, `EACCES`) rather than the thrown message, which carries the absolute path
   * and would put the operator's home directory into every envelope that reports this.
   */
  unreadable: string | null;
}

/**
 * The Changes a project currently has in flight, and whether that answer is known.
 *
 * Three callers each had their own copy of this listing and all three returned "none" for any error
 * at all. Only `ENOENT` means none: a project creates this directory with its first Change. Every
 * other failure — a permission the process does not hold, a path that is a file, a path-safety
 * refusal — means the answer is *unknown*, and returning "none" turns a read failure into a fact
 * that the caller then acts on.
 *
 * What each caller did with that fact is the reason this is worth a shared function rather than
 * three careful `catch` blocks: `upgrade` refuses to proceed while Changes are in flight and so
 * proceeded, without even the warning it emits when the user overrides it deliberately;
 * `contract status` reported no Change competing for a baseline element; `doctor` counted every
 * Flow as unused, because the Changes that use them are found by walking this directory.
 *
 * An archived Change is excluded on purpose and separately: it has already merged and is not in
 * flight. That is a filter, not a failure, and it is the same filter in all three places.
 */
export async function listChangeDirectories(project: ProjectContext): Promise<ChangeDirectoryListing> {
  try {
    const absolute = await safeResolve(project.root, project.changesPath);
    const entries = await readdir(absolute, { withFileTypes: true });
    return {
      ids: entries
        .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort(),
      unreadable: null,
    };
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') return { ids: [], unreadable: null };
    return { ids: [], unreadable: errno ?? (error instanceof Error ? error.message : String(error)) };
  }
}
