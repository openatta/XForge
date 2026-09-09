import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitSync } from '../host/git.js';

/*
 * `fileURLToPath`, not `new URL(...).pathname` + `path.resolve`: a `file://` URL's `.pathname` on
 * Windows keeps a leading slash before the drive letter (`/D:/...`), which `path.resolve` does not
 * strip — it prepends the cwd's own drive instead, producing a broken `D:\D:\...` path. `fileURLToPath`
 * handles this (and URL-encoding) correctly on every platform.
 */
const packageRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Git, synchronously, against this package's own directory.
 *
 * The reason this is not the same call the rest of the product makes has outlived the three
 * hand-written wrappers it used to warn about. `host/git.ts` now owns the plumbing, and the
 * distinction that survives is the one that was always the real one: this answers during
 * module-level identity resolution, before any `await` exists, so it goes through `runGitSync`.
 * The other axis is the root — every other caller asks about the *project*, and this asks about the
 * package the CLI was installed from, which is a different directory and often a different
 * repository. See `packageIsTracked` for why that matters.
 */
function git(args: string[]): string | null {
  const result = runGitSync(packageRoot, args);
  return result.ok ? result.stdout.trim() || null : null;
}

/**
 * Whether the repository `git -C packageRoot` lands in is one that actually contains this package.
 *
 * `git -C <dir>` walks up until it finds a repository, and an installed package has no `.git` of
 * its own — so it reports whatever repository happens to contain the install prefix. On a machine
 * whose global npm prefix is Homebrew's Node prefix, `xforge version` answered with
 * `repository: https://github.com/Homebrew/brew` and a Homebrew commit. A live run read that as
 * "xforge was installed by Homebrew" and sent its operator to `brew uninstall xforge`, which fails
 * with "No available formula" because the package was installed by npm all along.
 *
 * Asking whether the package's own `package.json` is tracked settles it: in a development checkout
 * of this repository it is, and the identity is the build's; under any install prefix it is not,
 * and the honest answer is that this build carries no repository identity. Publishing can supply
 * one through `XFORGE_BUILD_COMMIT` / `XFORGE_BUILD_REPOSITORY`, which are consulted first.
 */
function packageIsTracked(): boolean {
  return runGitSync(packageRoot, ['ls-files', '--error-unmatch', 'package.json']).ok;
}

export function actualGitIdentity(): { commit: string | null; repository: string | null } {
  const stamped = { commit: process.env.XFORGE_BUILD_COMMIT ?? null, repository: process.env.XFORGE_BUILD_REPOSITORY ?? null };
  if (stamped.commit || stamped.repository) return stamped;
  if (!packageIsTracked()) return { commit: null, repository: null };
  return { commit: git(['rev-parse', 'HEAD']), repository: git(['remote', 'get-url', 'origin']) };
}

/**
 * Where the running CLI actually lives, and whether that location is a checkout or an install.
 *
 * Reported next to `buildIdentity` because the two answer different questions and the reader who
 * has to act needs the second one: "which copy is answering, and how did it get here" is what
 * decides whether to reinstall, uninstall, or fix PATH. Before this, a null `buildIdentity` left
 * nothing at all to go on.
 */
export function runtimeInstallation(): { path: string; kind: 'git-checkout' | 'package' } {
  return { path: packageRoot, kind: packageIsTracked() ? 'git-checkout' : 'package' };
}

function filesUnder(directory: string, prefix: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const relative = path.posix.join(prefix, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) result.push(...filesUnder(absolute, relative));
    else if (stat.isFile()) result.push(relative);
  }
  return result;
}

export function runtimeCliIntegrity(): string {
  const candidates = [
    ...filesUnder(path.join(packageRoot, 'dist'), 'dist'),
    ...filesUnder(path.join(packageRoot, 'schemas'), 'schemas'),
    'package.json',
  ].filter((relative) => !relative.endsWith('.map')).sort();
  const aggregate = candidates.map((relative) => {
    const digest = createHash('sha256').update(readFileSync(path.join(packageRoot, ...relative.split('/')))).digest('hex');
    return `${relative}\0${digest}\n`;
  }).join('');
  return `sha256:${createHash('sha256').update(aggregate).digest('hex')}`;
}
