import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trackedAt } from '../../src/commands/upgrade.js';

/**
 * The paths a rollback offers to restore, when git decided to quote their names.
 *
 * `trackedAt` builds the `git restore --source=<head> -- <paths>` command that
 * `XFORGE_UPGRADE_ROLLBACK_BACKSTOP` prints, by asking `ls-tree` which of the managed directories
 * the recorded commit actually holds. It asked without `core.quotepath=false` and without undoing
 * git's C-quoting, so a directory whose tracked files were all non-ASCII came back as
 * `"xforge/scaffold/gates/\303\251.yaml"` — a string that does not start with `xforge/scaffold/`.
 * The directory read as untracked and was dropped from the command.
 *
 * That is worse than the failure the comment above `trackedAt` was written to prevent. There the
 * problem was a restore command that could not run; here it runs, and silently puts back less than
 * it names.
 *
 * A real repository rather than a stubbed one, because the thing under test is what git does with a
 * name — which is exactly what a fake would have to assume.
 */

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function repositoryWith(files: Record<string, string>): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'xforge-quotepath-'));
  roots.push(root);
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=T', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '--quiet');
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  git('add', '-A');
  git('commit', '--quiet', '-m', 'fixture');
  return { root, head: git('rev-parse', 'HEAD').stdout.trim() };
}

describe('tracked backstop paths', () => {
  it('finds a directory whose only tracked file has a non-ASCII name', async () => {
    const { root, head } = await repositoryWith({ 'xforge/scaffold/gates/é.yaml': 'spec: {}\n' });
    expect(trackedAt(root, head, ['xforge/scaffold', 'xforge/flows'])).toEqual(['xforge/scaffold']);
  });

  it('still finds one whose names are ordinary, and still omits one the commit does not hold', async () => {
    /* The negative half. A detector that reports everything is not a detector, and the point of
       `trackedAt` is that `git restore` aborts on a pathspec matching nothing and restores nothing —
       so naming a directory the commit does not have is what breaks the command. */
    const { root, head } = await repositoryWith({ 'xforge/flows/solid.yaml': 'stages: []\n' });
    expect(trackedAt(root, head, ['xforge/scaffold', 'xforge/flows'])).toEqual(['xforge/flows']);
  });

  it('finds one whose name git quotes even with quotepath off', async () => {
    /*
     * `core.quotepath=false` covers non-ASCII and nothing else: a double quote, a backslash or a
     * control character in a name is quoted whatever the option says. So the option alone is not
     * the fix, which is why the decoding is shared with the porcelain reader rather than dropped.
     */
    const { root, head } = await repositoryWith({ 'xforge/scripts/od\\d.txt': 'x\n' });
    expect(trackedAt(root, head, ['xforge/scripts'])).toEqual(['xforge/scripts']);
  });

  it('answers with nothing when the commit is not one this repository has', async () => {
    const { root } = await repositoryWith({ 'xforge/flows/solid.yaml': 'stages: []\n' });
    expect(trackedAt(root, '0'.repeat(40), ['xforge/flows'])).toEqual([]);
  });
});
