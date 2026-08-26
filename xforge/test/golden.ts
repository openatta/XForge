import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { xforgeRoot } from './helpers.js';

/**
 * Golden files: the recorded output of the thing this product exists to produce.
 *
 * XForge detects and generates files. Until now nothing compared the *content* of what it
 * generates — `install.test.ts` asserts that paths exist, and a change to any renderer therefore
 * passed the whole suite in silence. One was made during this work: an edit to
 * `adapters/shared.ts` altered every projected Rule file for every target, and 613 tests stayed
 * green.
 *
 * Two layers, because the risk is not evenly distributed:
 *
 * - **A digest manifest over every generated path.** Catches a file appearing, disappearing, moving
 *   or changing, at exact granularity, for all of them.
 * - **The full bytes of every *rendered* file.** "Rendered" is computed, not curated: a generated
 *   file whose bytes match no file in `scaffold/payload` was produced by a renderer rather than
 *   copied. Those are checked in as a real file tree, so a pull request shows the diff of what an
 *   Agent will actually read — which makes the golden file a reviewable artifact rather than an
 *   opaque hash.
 *
 * Regenerate with `XFORGE_UPDATE_GOLDEN=1`. The update is deliberately not a separate script: a
 * golden file updated in isolation is how a regression gets recorded as the new truth, so it costs
 * exactly one env var on the same test run and belongs in the same commit as the change it
 * describes.
 */

export const GOLDEN_ROOT = path.join(xforgeRoot, 'test', 'fixtures', 'golden');
export const UPDATING = process.env.XFORGE_UPDATE_GOLDEN === '1';

export interface FileTree {
  /** Project-relative POSIX path -> file bytes as UTF-8. */
  [relativePath: string]: string;
}

export function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Every regular file under `root`, keyed by POSIX-relative path.
 *
 * `skip` names top-level entries to leave out — the projection tests exclude `xforge/`, which is
 * the project's own governance tree rather than anything `install` renders, and carries the
 * ownership state whose contents are a function of the run rather than of the product.
 */
export async function readTree(root: string, skip: string[] = []): Promise<FileTree> {
  const tree: FileTree = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (prefix === '' && skip.includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute, relative);
      else tree[relative] = await readFile(absolute, 'utf8');
    }
  }
  await walk(root, '');
  return tree;
}

/** `path  sha256` lines, sorted, one per file — the same shape as `scaffold/files.sha256`. */
export function digestManifest(tree: FileTree): string {
  return `${Object.keys(tree).sort().map((relative) => `${digest(tree[relative]!)}  ${relative}`).join('\n')}\n`;
}

function goldenPath(...segments: string[]): string {
  return path.join(GOLDEN_ROOT, ...segments);
}

/**
 * Compares one text against its golden file, or rewrites it when updating.
 *
 * Returns the pair for the caller to assert on rather than asserting here: the failure message a
 * test framework prints for `expect(actual).toBe(expected)` on two long strings is the useful one,
 * and a helper that threw its own would replace it with something worse.
 */
export async function golden(relative: string, actual: string): Promise<{ actual: string; expected: string }> {
  const file = goldenPath(relative);
  if (UPDATING) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, actual);
    return { actual, expected: actual };
  }
  try {
    return { actual, expected: await readFile(file, 'utf8') };
  } catch {
    return {
      actual,
      expected: `(no golden file at test/fixtures/golden/${relative} — run the suite once with XFORGE_UPDATE_GOLDEN=1 to record it, and review the recorded content before committing it)`,
    };
  }
}

/**
 * Compares a whole tree of golden files under `directory`, and reports set differences as content.
 *
 * A missing or extra file is returned as a synthetic entry rather than as a separate assertion, so
 * one `toEqual` over the pair names every difference at once — "the golden tree has 87 files and
 * you produced 86" is a worse report than "this path is gone".
 */
export async function goldenTree(directory: string, actual: FileTree): Promise<{ actual: FileTree; expected: FileTree }> {
  const base = goldenPath(directory);
  if (UPDATING) {
    await rm(base, { recursive: true, force: true });
    for (const [relative, content] of Object.entries(actual)) {
      const file = path.join(base, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    return { actual, expected: actual };
  }
  let expected: FileTree;
  try { expected = await readTree(base); }
  catch { expected = {}; }
  const missing = Object.fromEntries(Object.keys(expected).filter((key) => !(key in actual)).map((key) => [key, '(this file is in the golden tree and was not produced)']));
  const extra = Object.fromEntries(Object.keys(actual).filter((key) => !(key in expected)).map((key) => [key, '(this file was produced and is not in the golden tree)']));
  return {
    actual: { ...actual, ...missing },
    expected: { ...expected, ...extra },
  };
}
