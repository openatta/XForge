import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { golden } from '../golden.js';
import { xforgeRoot } from '../helpers.js';

/**
 * What `@xforge/cli` publishes, recorded.
 *
 * `package.json` points `main` and `types` at `dist/index.js`, so `src/index.ts` is the library
 * surface, not an internal convenience — and its last line is `export * from './types.js'`, which
 * means every exported symbol in that module is published whether anybody intended it or not.
 *
 * That combination made the surface invisible. Narrowing 105 internal-only exports in this package
 * silently unpublished nine types along the way, all of them named in the signature of an interface
 * that stays public: a consumer using `Manifest` could still pass a module object and no longer name
 * `ProjectModule`. They were restored, and this recording is what makes the next such change a diff
 * rather than a discovery.
 *
 * It matters most for the module split that follows. `types.ts` is 1000 lines and is about to become
 * several; the point of the barrel is that consumers cannot tell, and this is the assertion that
 * they cannot.
 */
describe('published API', () => {
  it('exports exactly the recorded surface', async () => {
    /*
     * Re-export chains are followed to the end, because a barrel that points at another barrel is
     * exactly what this package now has. The first version of this resolver stopped after one hop,
     * so splitting `types.ts` into eight domain modules made the published surface read as empty —
     * a harness that reports a hundred lost exports when nothing was lost is worse than none.
     */
    const surface = await surfaceOf(path.join(xforgeRoot, 'src', 'index.ts'), './index.js');
    const lines = [...surface].map(([name, module]) => `${name}  <- ${module}`).sort();
    const { actual, expected } = await golden('public-api.txt', `${lines.join('\n')}\n`);
    /*
     * The names first, and separately. Moving one between modules changes the recording's second
     * column and nothing a consumer can observe, so the two are worth failing apart: this assertion
     * is the one that says the surface itself is intact.
     */
    const names = (text: string) => text.trim().split('\n').map((line) => line.split('  <- ')[0]).sort();
    expect(names(actual)).toEqual(names(expected));
    expect(actual).toBe(expected);
  });

  it('keeps the barrel the only published entry point', async () => {
    /*
     * `files` ships all of `dist`, so every module is physically reachable by a deep import. That is
     * a property of npm, not a promise this package makes — what it does promise is `main` and
     * `types`, and a second declared entry point would be a second surface to keep stable.
     */
    const manifest = JSON.parse(await readFile(path.join(xforgeRoot, 'package.json'), 'utf8')) as {
      main: string; types: string; bin: Record<string, string>; exports?: unknown;
    };
    expect(manifest.main).toBe('dist/index.js');
    expect(manifest.types).toBe('dist/index.d.ts');
    expect(manifest.bin).toEqual({ xforge: 'dist/cli.js' });
    expect(manifest.exports).toBeUndefined();
  });

  it('leaves no module exporting a symbol nothing outside it uses', async () => {
    /*
     * The rule the 105 downgrades established, kept from decaying. An export is a promise that
     * somebody may depend on this name; making one by habit is how a module ends up unable to change
     * its own internals without looking like it broke an API.
     *
     * `src/index.ts`, `src/types.ts` and the `src/types/` modules behind it are exempt by construction —
     * they exist to be re-exported —
     * and the test directories count as consumers, because a symbol exported for a unit test is
     * exported for a reason a reader can check.
     */
    const sources = new Map<string, string>();
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.name.endsWith('.ts')) sources.set(path.relative(xforgeRoot, absolute), await readFile(absolute, 'utf8'));
      }
    }
    await walk(path.join(xforgeRoot, 'src'));
    const consumers: string[] = [];
    for (const directory of [path.join(xforgeRoot, 'test'), path.join(xforgeRoot, '..', 'tests'), path.join(xforgeRoot, '..', 'scripts'), path.join(xforgeRoot, 'scripts')]) {
      await collect(directory, consumers);
    }
    const outside = consumers.join('\n');

    const offenders: string[] = [];
    for (const [file, source] of sources) {
      /* The barrel and everything it re-exports: these modules exist to be imported through it. */
      if (file.endsWith('src/index.ts') || file.endsWith('src/types.ts') || file.includes(`src${path.sep}types${path.sep}`)) continue;
      for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
        const name = match[1]!;
        const token = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
        const usedElsewhere = [...sources].some(([other, text]) => other !== file && token.test(text));
        if (!usedElsewhere && !token.test(outside)) offenders.push(`${name}  ${file}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});

/**
 * Every name a module publishes, with the module a reader would import it from.
 *
 * `attributed` is the *declaring* module rather than the barrel, so the recording stays stable when
 * a name moves between barrels and changes when it moves between homes — which is the distinction
 * the split this was written for depends on.
 */
async function surfaceOf(file: string, attributed: string, seen = new Set<string>(), into = new Map<string, string>()): Promise<Map<string, string>> {
  if (seen.has(file)) return into;
  seen.add(file);
  const source = await readFile(file, 'utf8');
  /*
   * Declarations win over re-exports, and a name is recorded once.
   *
   * The published surface is a set of names, not a count of the routes to one: `isVerificationRun`
   * is both named explicitly by the barrel and declared in the module the barrel recurses into, and
   * counting it twice made a pure move look like an addition. Attributing it to where it is declared
   * is also the more useful column — that is the file a reader opens.
   */
  for (const match of source.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    into.set(match[1]!, attributed);
  }
  for (const [, exported, module] of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    for (const entry of exported.split(',')) {
      const name = entry.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !into.has(name)) into.set(name, module);
    }
  }
  for (const [, module] of source.matchAll(/export\s+(?:type\s+)?\*\s*from\s*'([^']+)'/g)) {
    const target = path.resolve(path.dirname(file), module.replace(/\.js$/, '.ts'));
    await surfaceOf(target, module, seen, into);
  }
  return into;
}

async function collect(directory: string, into: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    /* `.tmp` holds a full copy of an installed CLI from live-engine runs; every symbol matches there. */
    if (entry.name === '.tmp' || entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute, into);
    else if (/\.(ts|mjs)$/.test(entry.name)) into.push(await readFile(absolute, 'utf8'));
  }
}
