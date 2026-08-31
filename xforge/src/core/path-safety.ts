import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { GENERATED_ROOTS } from '../constants.js';
import { XForgeError, diagnostic } from './errors.js';

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function normalizeRelative(input: string, label = 'path'): string {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new XForgeError(diagnostic('XFORGE_PATH_INVALID', `${label} must be a non-empty relative path.`, input || label));
  }
  if (input.includes('\\')) {
    throw new XForgeError(diagnostic('XFORGE_PATH_INVALID', `${label} must use forward slashes.`, input));
  }
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new XForgeError(diagnostic('XFORGE_PATH_ABSOLUTE', `${label} must be relative to the project root.`, input));
  }
  const normalized = path.posix.normalize(input.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new XForgeError(diagnostic('XFORGE_PATH_ESCAPE', `${label} cannot contain parent traversal.`, input));
  }
  return normalized === '' ? '.' : normalized;
}

/**
 * The logical roots a project relocates, checked against each other and against generated targets.
 *
 * Written as a loop over pairs rather than as the comparisons themselves. Two roots need one
 * comparison and a third needs three, which is exactly the arithmetic that leaves a pair out: the
 * version of this function that compared `specs` with `changes` in a hand-written condition would
 * have grown a second condition for contracts and, on the evidence of every other duplicated list
 * in this codebase, not a third. `pathsOverlap` is already exported and is the same judgement, so
 * the pairs are generated and the judgement is borrowed.
 *
 * Contracts overlapping Specs is the pair with the most to lose. Both trees hold a canonical record
 * that only a merged delta writes, and nothing downstream tells them apart by anything but path --
 * so a contract merged into the Specs tree would sit where every reader expects a Requirement, with
 * no delta that produced it.
 */
export function assertLogicalPaths(specs: string, changes: string, contracts: string): void {
  const roots = [
    { key: 'specs', value: normalizeRelative(specs, 'project.paths.specs') },
    { key: 'changes', value: normalizeRelative(changes, 'project.paths.changes') },
    { key: 'contracts', value: normalizeRelative(contracts, 'project.paths.contracts') },
  ] as const;
  const details = Object.fromEntries(roots.map((root) => [root.key, root.value]));

  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      const left = roots[index]!;
      const right = roots[other]!;
      if (!pathsOverlap(left.value, right.value)) continue;
      throw new XForgeError(diagnostic(
        'XFORGE_PATHS_OVERLAP',
        `The ${left.key} and ${right.key} paths must be distinct and cannot contain one another.`,
        'xforge/manifest.yaml',
        'error',
        details,
      ));
    }
  }

  for (const generated of GENERATED_ROOTS) {
    for (const root of roots) {
      if (root.value !== generated && !root.value.startsWith(`${generated}/`)) continue;
      throw new XForgeError(diagnostic(
        'XFORGE_PATH_GENERATED_TARGET',
        `The ${root.key} path cannot be inside a generated Adapter target.`,
        'xforge/manifest.yaml',
        'error',
        { ...details, generated },
      ));
    }
  }
}

async function existingRealpath(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch {
    return null;
  }
}

export async function safeResolve(root: string, relativeInput: string, options: { createParent?: boolean } = {}): Promise<string> {
  const relative = normalizeRelative(relativeInput);
  const rootAbsolute = path.resolve(root);
  const rootReal = (await existingRealpath(rootAbsolute)) ?? rootAbsolute;
  const destination = path.resolve(rootAbsolute, ...relative.split('/'));
  if (!isInside(rootAbsolute, destination)) {
    throw new XForgeError(diagnostic('XFORGE_PATH_ESCAPE', 'Resolved path escapes the project root.', relative));
  }

  const pieces = relative === '.' ? [] : relative.split('/');
  let cursor = rootAbsolute;
  for (const piece of pieces) {
    cursor = path.join(cursor, piece);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        const target = await realpath(cursor);
        if (!isInside(rootReal, target)) {
          throw new XForgeError(diagnostic(
            'XFORGE_SYMLINK_ESCAPE',
            'A declared or generated path follows a symlink outside the project root.',
            relative,
          ));
        }
      }
      const resolved = await realpath(cursor);
      if (!isInside(rootReal, resolved)) {
        throw new XForgeError(diagnostic('XFORGE_SYMLINK_ESCAPE', 'Path resolution escapes through a symlink.', relative));
      }
    } catch (error) {
      if (error instanceof XForgeError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      break;
    }
  }

  if (options.createParent) {
    const parentRelative = path.posix.dirname(relative);
    if (parentRelative !== '.') await safeResolve(root, parentRelative);
    await mkdir(path.dirname(destination), { recursive: true });
    const parentReal = await realpath(path.dirname(destination));
    if (!isInside(rootReal, parentReal)) {
      throw new XForgeError(diagnostic('XFORGE_SYMLINK_ESCAPE', 'Generated parent directory escapes the project.', relative));
    }
  }
  return destination;
}

export function toProjectPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

export function assertResourceId(id: string, sourcePath = 'xforge/manifest.yaml'): void {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) {
    throw new XForgeError(diagnostic('XFORGE_RESOURCE_ID_INVALID', `Invalid resource ID: ${id}`, sourcePath));
  }
}

export function pathsOverlap(leftInput: string, rightInput: string): boolean {
  const left = normalizeRelative(leftInput);
  const right = normalizeRelative(rightInput);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
