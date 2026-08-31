import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { XForgeError } from '../../src/core/errors.js';
import { assertLogicalPaths, assertResourceId, normalizeRelative, safeResolve } from '../../src/core/path-safety.js';
import { temporaryDirectory } from '../helpers.js';

function codeOf(operation: () => unknown): string | null {
  try { operation(); return null; } catch (error) { return error instanceof XForgeError ? error.diagnostics[0]?.code ?? null : null; }
}

describe('path safety', () => {
  it('rejects traversal, absolute, Windows, and backslash paths', () => {
    expect(codeOf(() => normalizeRelative('../escape'))).toBe('XFORGE_PATH_ESCAPE');
    expect(codeOf(() => normalizeRelative('/escape'))).toBe('XFORGE_PATH_ABSOLUTE');
    expect(codeOf(() => normalizeRelative('C:\\escape'))).toBe('XFORGE_PATH_INVALID');
    expect(codeOf(() => normalizeRelative('docs\\specs'))).toBe('XFORGE_PATH_INVALID');
  });

  it('rejects overlapping and generated logical roots', () => {
    expect(codeOf(() => assertLogicalPaths('docs', 'docs/changes', 'docs/contracts'))).toBe('XFORGE_PATHS_OVERLAP');
    expect(codeOf(() => assertLogicalPaths('.agents/specs', 'docs/changes', 'docs/contracts'))).toBe('XFORGE_PATH_GENERATED_TARGET');
  });

  it('compares every logical root against every other, not only the first pair', () => {
    /*
     * Two roots needed one comparison and a third needs three, which is the shape that gets a pair
     * quietly skipped. Contracts overlapping Specs is the pair with the most to lose: a merge that
     * wrote a contract into the Specs tree would put a record no delta produced where every reader
     * expects one, and nothing downstream distinguishes them by path.
     */
    expect(codeOf(() => assertLogicalPaths('a/specs', 'b/changes', 'a/specs/http'))).toBe('XFORGE_PATHS_OVERLAP');
    expect(codeOf(() => assertLogicalPaths('a/specs', 'b/changes', 'b/changes'))).toBe('XFORGE_PATHS_OVERLAP');
    expect(codeOf(() => assertLogicalPaths('a/specs', 'b/changes', '.agents/contracts'))).toBe('XFORGE_PATH_GENERATED_TARGET');
    expect(codeOf(() => assertLogicalPaths('a/specs', 'b/changes', 'c/contracts'))).toBe(null);
  });

  it('rejects malicious resource names', () => {
    expect(codeOf(() => assertResourceId('../../owned'))).toBe('XFORGE_RESOURCE_ID_INVALID');
    expect(codeOf(() => assertResourceId('Bad_Name'))).toBe('XFORGE_RESOURCE_ID_INVALID');
  });

  it('detects a symlink escape before writes', async () => {
    const root = await temporaryDirectory('xforge-path-');
    const outside = await temporaryDirectory('xforge-outside-');
    await mkdir(path.join(root, 'safe'));
    await symlink(outside, path.join(root, 'safe', 'link'));
    await expect(safeResolve(root, 'safe/link/file.txt')).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'XFORGE_SYMLINK_ESCAPE' })],
    });
  });
});
