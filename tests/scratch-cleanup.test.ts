import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryRoot } from '../xforge/test/helpers.js';

/**
 * `scripts/release-check.mjs` minted an npm cache under the OS temp directory and never removed it.
 * It ends through `fail()` far more often than it reaches its last line, so every failed release
 * check left a populated cache behind: thirty of them, most of a gigabyte, and eventually a disk
 * with no space left — which stops the Bash tool outright, so the failure cannot even be cleaned up
 * from inside a session.
 *
 * Nothing detected it because a leak is invisible at the point it happens; it only shows up as an
 * unrelated failure much later. So the rule is checked at the source instead: a script that mints
 * scratch must be the script that removes it.
 */
describe('scripts clean up the scratch they mint', () => {
  const scriptsRoot = path.join(repositoryRoot, 'scripts');

  async function scripts(): Promise<string[]> {
    return (await readdir(scriptsRoot)).filter((name) => name.endsWith('.mjs'));
  }

  it('pairs every mkdtempSync with a removal in the same script', async () => {
    const offenders: string[] = [];
    for (const name of await scripts()) {
      const source = await readFile(path.join(scriptsRoot, name), 'utf8');
      if (!source.includes('mkdtempSync(')) continue;
      // A script that mints scratch must also remove scratch. `clean-tmp.mjs` is exempt from
      // minting but is the removal for everyone else, so it never mints in the first place.
      if (!source.includes('rmSync(')) offenders.push(name);
    }
    expect(offenders, 'these scripts create temp directories they never remove').toEqual([]);
  });

  /*
   * Removing on the happy path is not removing. `release-check.mjs` reaches its final line only when
   * every check passes, which is the case that matters least — the leak was entirely on the failure
   * paths, so the removal has to be attached to process exit.
   */
  it('removes the release-check npm cache on exit, not only on success', async () => {
    const source = await readFile(path.join(scriptsRoot, 'release-check.mjs'), 'utf8');
    expect(source).toMatch(/process\.on\('exit',[\s\S]*rmSync\(npmCache/);
    expect(source).toContain('ownsNpmCache');
    // A caller supplying a warm cache owns it; emptying someone else's cache is not cleanup.
    expect(source).toContain('!process.env.XFORGE_RELEASE_NPM_CACHE');
  });

  it('keeps a sweeper wired into the test lifecycle so a killed run is paid off by the next one', async () => {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
    expect(manifest.scripts.posttest).toContain('clean-tmp.mjs');
    expect(manifest.scripts['posttest:product']).toContain('clean-tmp.mjs');
    expect(manifest.scripts['clean:tmp']).toContain('clean-tmp.mjs');
  });

  /*
   * The sweeper must never delete a live run's own output. With recording gone, the project tree and
   * `live-engine-results` are the *only* record that a paid run happened at all — roughly $30 of
   * real model calls with nothing packaging them afterwards, so a sweep that took either would
   * destroy the run with no way to recover it.
   */
  it('spares the live-engine project directories and results by default', async () => {
    const source = await readFile(path.join(scriptsRoot, 'clean-tmp.mjs'), 'utf8');
    const guarded = source.slice(source.indexOf('const liveEngineTemp'));
    const defaultBranch = guarded.slice(guarded.indexOf('} else if'));
    expect(defaultBranch).not.toContain('live-engine-results');
    // Only per-run logs, which are regenerable, are named in the default sweep.
    expect(defaultBranch).toContain("name.endsWith('.log')");
  });

  /*
   * The age guard is what makes it safe to run automatically: two suites can be in flight at once,
   * and sweeping the current run's scratch out from under it would be worse than the leak.
   */
  it('leaves recent scratch alone so a concurrent run is never swept', async () => {
    const source = await readFile(path.join(scriptsRoot, 'clean-tmp.mjs'), 'utf8');
    expect(source).toMatch(/MINIMUM_AGE_MS\s*=/);
    expect(source).toContain('if (!all && now - stats.mtimeMs < MINIMUM_AGE_MS) continue;');
  });
});
