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
    const source = await readFile(path.join(xforgeRoot, 'src', 'index.ts'), 'utf8');

    const named = [...source.matchAll(/export\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)]
      .flatMap(([, names, module]) => names
        .split(',')
        .map((entry) => entry.trim().split(/\s+as\s+/).pop()!.trim())
        .filter(Boolean)
        .map((name) => `${name}  <- ${module}`));

    /* `export * from './types.js'` publishes whatever that module exports, so the surface is only
       knowable by reading it — which is exactly why it is recorded rather than assumed. */
    const starred: string[] = [];
    for (const [, module] of source.matchAll(/export\s*\*\s*from\s*'([^']+)'/g)) {
      const file = path.join(xforgeRoot, 'src', module.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
      const exported = await readFile(file, 'utf8');
      for (const match of exported.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
        starred.push(`${match[1]}  <- ${module}`);
      }
    }

    const { actual, expected } = await golden('public-api.txt', `${[...named, ...starred].sort().join('\n')}\n`);
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
     * `src/index.ts` and `src/types.ts` are exempt by construction — they exist to be re-exported —
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
      if (file.endsWith('src/index.ts') || file.endsWith('src/types.ts')) continue;
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
