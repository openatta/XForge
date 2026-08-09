import { lstat, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import { GENERATED_ROOTS } from '../constants.js';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { safeResolve } from '../core/path-safety.js';
import { installedTargets, readOwnership, toOwnershipV2 } from '../install/ownership.js';
import { applyManagedTransaction } from '../install/writer.js';

const CLEANUP_COMPATIBILITY_IGNORED = new Set([
  'XFORGE_CLI_IDENTITY_MISMATCH',
  'XFORGE_LOCK_CLI_MISMATCH',
]);

async function currentFile(project: ProjectContext, relative: string): Promise<{ digest: string; invalidType: boolean } | null> {
  try {
    const absolute = await safeResolve(project.root, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return { digest: '', invalidType: true };
    return { digest: sha256(await readFile(absolute)), invalidType: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function pruneEmptyParents(project: ProjectContext, deleted: string[]): Promise<void> {
  for (const relative of deleted) {
    const root = GENERATED_ROOTS.find((candidate) => relative === candidate || relative.startsWith(`${candidate}/`));
    if (!root) continue;
    let cursor = path.posix.dirname(relative);
    while (cursor !== '.' && cursor !== root) {
      try { await rmdir(await safeResolve(project.root, cursor)); }
      catch { break; }
      cursor = path.posix.dirname(cursor);
    }
    try { await rmdir(await safeResolve(project.root, root)); } catch {}
  }
}

export async function executeUninstall(
  project: ProjectContext,
  options: { target?: TargetId; dryRun: boolean },
): Promise<{ data: Record<string, unknown>; diagnostics: Diagnostic[]; changes: FileChange[] }> {
  const previous = await readOwnership(project);
  const installed = installedTargets(previous);
  if (installed.length === 0) {
    throw new XForgeError(diagnostic('XFORGE_NOT_INSTALLED', 'uninstall requires an existing installation record.', 'xforge/.state.json'), { root: project.root });
  }
  if (options.target && !installed.includes(options.target)) {
    throw new XForgeError(diagnostic('XFORGE_TARGET_NOT_INSTALLED', `Target is not installed: ${options.target}`, 'xforge/.state.json'), { root: project.root });
  }
  const targets = options.target ? [options.target] : installed;
  const next = toOwnershipV2(project, previous);
  const diagnostics = project.diagnostics.filter((item) => !CLEANUP_COMPATIBILITY_IGNORED.has(item.code));
  const changes: FileChange[] = [];
  const writes = new Map<string, string | Buffer | null>();

  for (const target of targets) {
    const installation = next.targets[target];
    if (!installation) continue;
    for (const [relative, record] of Object.entries(installation.files).sort(([left], [right]) => left.localeCompare(right))) {
      const current = await currentFile(project, relative);
      if (!current) {
        changes.push({ action: 'skip', path: relative, source: record.source, target, reason: 'Managed file is already absent.' });
        continue;
      }
      if (current.invalidType || current.digest !== record.lastInstalledDigest) {
        changes.push({ action: 'conflict', path: relative, digest: current.digest, source: record.source, target, reason: 'Managed file differs from its installation record.' });
        diagnostics.push(diagnostic('XFORGE_UNINSTALL_CONFLICT', 'Modified or non-file managed destination cannot be uninstalled.', relative));
        continue;
      }
      changes.push({ action: 'delete', path: relative, digest: current.digest, source: record.source, target });
      writes.set(relative, null);
    }
  }

  const hasErrors = diagnostics.some((item) => item.severity === 'error');
  for (const target of targets) delete next.targets[target];
  const remainingTargets = installedTargets(next);
  if (remainingTargets.length === 0) {
    changes.push({ action: 'delete', path: 'xforge/.state.json', source: 'xforge:ownership' });
    writes.set('xforge/.state.json', null);
  } else {
    next.generatedAt = new Date().toISOString();
    const content = `${JSON.stringify(next, null, 2)}\n`;
    changes.push({ action: 'modify', path: 'xforge/.state.json', digest: sha256(content), source: 'xforge:ownership' });
    writes.set('xforge/.state.json', content);
  }

  if (!options.dryRun && !hasErrors) {
    await applyManagedTransaction(project, writes);
    await pruneEmptyParents(project, changes.filter((item) => item.action === 'delete' && item.path !== 'xforge/.state.json').map((item) => item.path));
  }
  return {
    data: {
      dryRun: options.dryRun,
      targets,
      remainingTargets,
      summary: Object.fromEntries(['delete', 'skip', 'conflict'].map((action) => [action, changes.filter((item) => item.action === action).length])),
    },
    diagnostics,
    changes,
  };
}
