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

export function assertLogicalPaths(specs: string, changes: string): void {
  const left = normalizeRelative(specs, 'project.paths.specs');
  const right = normalizeRelative(changes, 'project.paths.changes');
  if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
    throw new XForgeError(diagnostic(
      'XFORGE_PATHS_OVERLAP',
      'Specs and Changes paths must be distinct and cannot contain one another.',
      'xforge/manifest.yaml',
      'error',
      { specs: left, changes: right },
    ));
  }
  for (const generated of GENERATED_ROOTS) {
    if (left === generated || left.startsWith(`${generated}/`) || right === generated || right.startsWith(`${generated}/`)) {
      throw new XForgeError(diagnostic(
        'XFORGE_PATH_GENERATED_TARGET',
        'Specs and Changes paths cannot be inside a generated Adapter target.',
        'xforge/manifest.yaml',
        'error',
        { specs: left, changes: right, generated },
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
