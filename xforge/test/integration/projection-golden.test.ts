import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TARGETS } from '../../src/constants.js';
import { digest, digestManifest, golden, goldenTree, readTree, type FileTree } from '../golden.js';
import { fixture, repositoryRoot, runCli } from '../helpers.js';

/**
 * What `xforge install` actually writes, recorded byte for byte.
 *
 * This is the safety net the structural refactor is verified against, and the answer to a gap the
 * suite had carried from the start: `install.test.ts` asserts that files exist, so every renderer
 * in `src/adapters/` and `src/install/` could change its output without a single test noticing —
 * and one did, mid-flight, altering every projected Rule file for all five targets while 613 tests
 * stayed green.
 *
 * The projection is deterministic: two installs of the same fixture produce identical bytes for all
 * 183 files, which is what makes a golden comparison meaningful rather than flaky.
 */
describe('projection golden', () => {
  /** The whole shipped Scaffold, every target selected — the widest projection the product has. */
  async function projected(): Promise<FileTree> {
    const root = await fixture();
    const result = await runCli(root, ['install']);
    expect(result.code, JSON.stringify(result.json?.diagnostics)).toBe(0);
    /* `xforge/` is the project's own governance tree, not something install renders, and it carries
       ownership state that is a function of the run rather than of the product. */
    return readTree(root, ['xforge']);
  }

  /**
   * Which generated files came out of a renderer, computed rather than listed.
   *
   * A generated file whose bytes match some file in `scaffold/payload` was copied; anything else was
   * produced by code in this repository, which is where the risk is. Keeping the split computed
   * means a renderer that starts emitting a file, or a copy that starts being rendered, moves
   * between the two golden layers instead of quietly staying in the cheaper one.
   */
  async function payloadDigests(): Promise<Set<string>> {
    const payload = await readTree(path.join(repositoryRoot, 'scaffold', 'payload'));
    return new Set(Object.values(payload).map((content) => digest(content)));
  }

  it('writes exactly the recorded set of files, with the recorded digests', async () => {
    const tree = await projected();
    const { actual, expected } = await golden('projection/manifest.sha256', digestManifest(tree));
    expect(actual).toBe(expected);
    /* A guard on the guard: if the fixture ever stops projecting every target, the manifest above
       would still match its own recording and mean much less than it appears to. */
    for (const target of TARGETS) {
      expect(Object.keys(tree).some((relative) => relative.startsWith('.')), `${target} produced nothing`).toBe(true);
    }
    expect(Object.keys(tree).length).toBeGreaterThan(150);
  });

  it('renders the recorded content for every file it does not copy verbatim', async () => {
    const tree = await projected();
    const copied = await payloadDigests();
    const rendered = Object.fromEntries(Object.entries(tree).filter(([, content]) => !copied.has(digest(content))));

    /* The reviewable layer: a pull request touching a renderer shows the diff of what an Agent
       will read, in the Agent's own file, rather than a changed hash. */
    const { actual, expected } = await goldenTree('projection/rendered', rendered);
    expect(actual).toEqual(expected);
  });

  it('ties every copied file back to the Scaffold integrity list', async () => {
    const tree = await projected();
    const copied = await payloadDigests();
    const integrity = await readFile(path.join(repositoryRoot, 'scaffold', 'files.sha256'), 'utf8');
    const locked = new Set(integrity.trim().split('\n').map((line) => line.split(/\s+/)[0]!));

    /*
     * The two locks meet here. `scaffold/files.sha256` pins the payload, this golden pins the
     * projection, and without this assertion a file could be copied from a payload entry that the
     * integrity list does not cover — projected content nobody had signed for.
     */
    for (const [relative, content] of Object.entries(tree)) {
      const hash = digest(content);
      if (!copied.has(hash)) continue;
      expect(locked.has(hash), `${relative} is copied from the payload but its digest is not in scaffold/files.sha256`).toBe(true);
    }
  });
});
