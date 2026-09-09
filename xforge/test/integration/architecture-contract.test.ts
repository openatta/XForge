/*
 * @red-first coverage-only: this records existing structure rather than proving a fix. Its golden does not exist on the parent commit, so `golden()` returns a placeholder and the file goes red there for a reason that has nothing to do with whether it discriminates. The test architecture calls that green the false kind; what makes this file worth having is that the next unintended edge becomes a reviewable diff instead of somebody's later discovery.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { golden } from '../golden.js';
import { xforgeRoot } from '../helpers.js';

/**
 * Which layer may depend on which, recorded.
 *
 * `src/` has directories that mean something — `host/` is where the outside world is touched,
 * `write/` is where a governed record is committed to disk, `core/` decides, `commands/`
 * orchestrates, `cli/` and `protocol/` are argv and the envelope — and until now nothing said so.
 * The structure was a convention, and a convention that nothing checks is a convention that has
 * already drifted: `core/archiver.ts` imported `commands/check.ts`, which is the dependency
 * direction inverted, and it stayed that way long enough for the module to be published from the
 * wrong half of the tree.
 *
 * Two things are asserted here, and they are different in kind:
 *
 * - **The edge set, as a golden.** A new edge between two directories is not necessarily wrong, so
 *   this is a fingerprint rather than a rule: it fails with "this changed, confirm it is
 *   deliberate", which is what the contract layer is for.
 * - **Three invariants, as outright refusals.** These are not "confirm it": they are the properties
 *   the layering work established, and an edge that breaks one is a defect regardless of intent.
 */

const SOURCE_ROOT = path.join(xforgeRoot, 'src');

/** The directory a source file belongs to, with files directly in `src/` reported as `(root)`. */
function layerOf(absolute: string): string {
  const relative = path.relative(SOURCE_ROOT, absolute);
  const first = relative.split(path.sep)[0]!;
  return first.endsWith('.ts') ? '(root)' : first;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(absolute));
    else if (entry.name.endsWith('.ts')) found.push(absolute);
  }
  return found;
}

interface Edge { from: string; to: string; via: string }

/** Every import that crosses a directory boundary, with the file that makes it. */
async function crossLayerEdges(): Promise<Edge[]> {
  const files = await sourceFiles(SOURCE_ROOT);
  const edges: Edge[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const from = layerOf(file);
    for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
      /* `.js` in the specifier, `.ts` on disk: this package emits ESM and imports itself by the
         built name, which is what the resolver here has to undo before asking where the file is. */
      const target = path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, '.ts'));
      const to = layerOf(target);
      if (from !== to) edges.push({ from, to, via: path.relative(SOURCE_ROOT, file) });
    }
  }
  return edges;
}

describe('module layering', () => {
  it('records which layer depends on which', async () => {
    const edges = await crossLayerEdges();
    const counted = new Map<string, number>();
    for (const edge of edges) {
      const key = `${edge.from} -> ${edge.to}`;
      counted.set(key, (counted.get(key) ?? 0) + 1);
    }
    /* The count travels with the edge so a *volume* change is visible too: one module reaching into
       another is a different fact from twenty doing it, and only the second says a boundary has
       stopped being one. */
    const lines = [...counted.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([edge, count]) => `${edge}  (${count})`);
    const { actual, expected } = await golden('contracts/module-edges.txt', `${lines.join('\n')}\n`);
    expect(actual).toBe(expected);
  });

  it('keeps core out of the command layer above it', async () => {
    /*
     * The direction that was actually inverted. `core/archiver.ts` held `executeArchive` and called
     * `commands/check.ts`; `commands/archive.ts` existed as a one-line re-export, so the intended
     * home was declared and unoccupied. Anything decided in `core/` that needs a command is a
     * command that belongs in `commands/`.
     */
    const offenders = (await crossLayerEdges())
      .filter((edge) => edge.from === 'core' && edge.to === 'commands')
      .map((edge) => edge.via);
    expect(offenders).toEqual([]);
  });

  it('spawns git from exactly one module', async () => {
    /*
     * Six hand-written wrappers with four opinions about `core.quotepath` and five about what a
     * failure looks like is the state this replaced, and the drift was real rather than
     * hypothetical. `host/git.ts` owns the plumbing; a second `spawn('git', ...)` anywhere is the
     * beginning of the seventh.
     */
    const files = await sourceFiles(SOURCE_ROOT);
    const spawners: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/(?:spawn|spawnSync|execFile|execFileSync)\(\s*'git'/.test(source)) spawners.push(path.relative(SOURCE_ROOT, file));
    }
    expect(spawners).toEqual(['host/git.ts']);
  });

  it('creates a record exclusively from exactly one module', async () => {
    /*
     * The write half of the governed sequence, which is the half that can be checked precisely.
     *
     * `link()` onto a temp file is how "only if nobody got here first" is expressed here, and it
     * used to live in `commands/transition.ts`. It belongs with the unwind that pairs with it.
     *
     * The unwind itself is deliberately *not* asserted textually. The obvious detector — a module
     * holding both `atomicWrite` and `recordAudit` — reports five modules that are doing nothing
     * wrong: archive's transaction, check's Gate-reuse records, verification's receipt, and
     * `core/audit.ts` writing its own index. A detector that needs a hand-kept exclusion list to
     * stay quiet is the stale hand-kept list this layer exists to avoid, so the honest position is
     * that this one property is held by review rather than by a test.
     */
    const files = await sourceFiles(SOURCE_ROOT);
    const linkers: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/\blink\(/.test(source)) linkers.push(path.relative(SOURCE_ROOT, file));
    }
    expect(linkers).toEqual([path.join('write', 'governed.ts')]);
  });
});
