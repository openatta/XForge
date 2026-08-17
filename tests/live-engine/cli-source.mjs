import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/* fileURLToPath, not .pathname + path.resolve: a file:// URL's .pathname keeps a leading
   slash before a Windows drive letter (/D:/...), which path.resolve does not strip -- it
   prepends the cwd's own drive instead, producing a broken D:\D:\... path. */
const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const CLI_SOURCE_MODES = ['npm', 'local'];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/**
 * A digest of everything that ends up inside the packed tarball, used as its cache key.
 *
 * Covers the CLI source, its schemas, its package manifest, and the Scaffold payload (whose own
 * `files.sha256` already summarises every file in it). Content, not timestamps: a checkout or a
 * touch must not invalidate the cache, and an edit must.
 */
async function sourceDigest() {
  const roots = [
    path.join(repositoryRoot, 'xforge', 'src'),
    path.join(repositoryRoot, 'xforge', 'schemas'),
  ];
  const hash = createHash('sha256');
  for (const root of roots) {
    const entries = [];
    const walk = async (directory) => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else entries.push(full);
      }
    };
    await walk(root);
    for (const file of entries) {
      hash.update(path.relative(repositoryRoot, file));
      hash.update(await readFile(file));
    }
  }
  for (const file of [
    path.join(repositoryRoot, 'xforge', 'package.json'),
    path.join(repositoryRoot, 'scaffold', 'files.sha256'),
  ]) {
    hash.update(await readFile(file));
  }
  return hash.digest('hex').slice(0, 12);
}

async function cliPackageVersion() {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'xforge', 'package.json'), 'utf8'));
  return packageJson.version;
}

/**
 * Resolves an npm install spec for @xforge/cli:
 * - `npm` mode installs the exact published version from the real registry, matching what a
 *   real project does (`npm install --save-dev --save-exact @xforge/cli@<version>`).
 * - `local` mode packs the repository's own build into a tarball with `npm pack ./xforge` and
 *   installs from that tarball, so a developer can regression-test an uncommitted local change
 *   through the exact same install/init/Skill path as the npm-published CLI, without a registry
 *   round-trip or a real publish.
 */
export async function resolveInstallSpec({ mode, packRoot }) {
  if (!CLI_SOURCE_MODES.includes(mode)) throw new Error(`Unknown CLI source mode: ${mode}. Use one of ${CLI_SOURCE_MODES.join(', ')}.`);
  const version = await cliPackageVersion();
  if (mode === 'npm') return { spec: `@xforge/cli@${version}`, version, source: 'npm' };

  /*
   * The tarball is shared across scenarios, not packed per scenario. Building and packing is the
   * only step of a `--cli-source local` run that touches the shared repository rather than the
   * isolated project: `npm run build`'s clean step deletes `xforge/dist`, so three Flows starting
   * together used to delete each other's build and fail before a single model call was made — one
   * of them installing a tarball packed from a half-empty dist. Packing once into a shared
   * location and reusing it makes the Flows genuinely parallelizable.
   *
   * **The cache is keyed by what was built, not by the version it calls itself.** It used to be
   * `xforge-cli-<version>.tgz`, and during development the version does not move while the code
   * does — so a run silently installed a build from hours earlier. That cost a full three-scenario
   * run: the prompts told the Agent to use a command the packed CLI did not contain, and nothing
   * anywhere reported a mismatch, because from every component's point of view 0.7.12 is 0.7.12.
   *
   * The previous comment here said to delete the directory to force a rebuild, and that
   * `run-matrix.mjs` did so on a single-Flow run. It did not — there was no such deletion anywhere
   * in the harness. A documented mitigation that does not exist is worse than an acknowledged gap,
   * because it stops the next reader looking.
   *
   * **The shared tarball only made a *warm* start parallelizable.** Reading the cache and building
   * on a miss is check-then-act, and on a cold start every scenario misses: six launched together
   * all ran `npm run build`, whose clean step deletes `scaffold/payload`, and they deleted each
   * other's tree mid-copy. Three died on ENOTEMPTY/ENOENT before a model call. The paragraph above
   * claimed parallelism the code did not have — the same defect it convicts its predecessor of, one
   * paragraph later. `buildOnceInto` closes it by serialising the build itself, which is the part
   * that touches the shared repository.
   */
  const sharedPackRoot = path.join(repositoryRoot, 'tests', '.tmp', 'live-engine-npm-pack');
  await mkdir(sharedPackRoot, { recursive: true });
  const key = await sourceDigest();
  const existing = path.join(sharedPackRoot, `xforge-cli-${version}-${key}.tgz`);
  await buildOnceInto(existing, sharedPackRoot);
  return { spec: existing, version, source: 'local-tarball' };
}

const cached = (file) => readFile(file).then(() => true, () => false);
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function buildOnceInto(target, sharedPackRoot) {
  return produceOnce({
    target,
    lock: `${target}.lock`,
    produce: () => {
      run('npm', ['run', 'build', '--prefix', 'xforge'], repositoryRoot);
      const packed = JSON.parse(run('npm', [
        'pack', './xforge', '--json', '--ignore-scripts', '--pack-destination', sharedPackRoot,
      ], repositoryRoot));
      /* `npm pack` names the file after the version, which is exactly the name that cannot serve as
         a cache key here. Renaming it to the content-keyed name is what makes the lookup above ever
         hit, and what keeps two differing builds of one version from occupying the same path.
         Rename is atomic, so a waiter never observes a partially written tarball. */
      return rename(path.join(sharedPackRoot, packed[0]?.filename ?? 'missing.tgz'), target);
    },
  });
}

/**
 * Runs `produce` at most once across concurrent processes racing to create `target`.
 *
 * Exported for its test: the property that matters is exactly-once under concurrency, and driving
 * it with a real `npm run build` would take minutes and mutate the shared repository — so `produce`
 * is a parameter. What the harness passes for it is the build; what the test passes is a counter.
 *
 * The lock is a directory, because `mkdir` is the one filesystem operation that both creates and
 * tests for existence atomically — a "does it exist, then create it" pair is the very race being
 * closed here. The holder's pid goes inside it: a run killed mid-build (Ctrl-C, or a harness that
 * pkills its own children) would otherwise leave a lock nothing ever releases, and the next run
 * would wait out the full timeout for a process that died minutes ago.
 */
export async function produceOnce({ target, lock, produce, pollMs = 1000, timeoutMs = 15 * 60 * 1000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cached(target)) return;
    try {
      await mkdir(lock);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await holderIsGone(lock)) {
        /* Breaking a lock is only safe because the pid is gone: the work it guarded cannot still be
           in progress, so whatever half-finished state it left is about to be redone. */
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for another run to produce ${path.basename(target)}.\n  lock: ${lock}\n`
          + 'A live build takes well under a minute, so a lock this old is either work that hung '
          + 'or a stale directory. Remove it and rerun.',
        );
      }
      await delay(pollMs);
      continue;
    }
    try {
      await writeFile(path.join(lock, 'pid'), `${process.pid}\n`);
      /* Re-check inside the lock: the process that just released it may have been producing this
         exact target, in which case there is nothing left to do. */
      if (await cached(target)) return;
      await produce();
      return;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

async function holderIsGone(lock) {
  const pid = Number((await readFile(path.join(lock, 'pid'), 'utf8').catch(() => '')).trim());
  /* No pid file yet means the holder is mid-acquire, not dead. Treating that as stale would break
     a lock a live process is about to use. */
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/**
 * Installs @xforge/cli *outside* the project under test, and returns the directory to put on PATH.
 *
 * It used to install into the project as a devDependency, which meant `setup.mjs` had to write a
 * `package.json` there first — so every scenario this harness can produce is a Node project, no
 * matter what its seed contains. That was not a neutral detail. The shipped `unit-tests` and
 * `security-scan` Gates ran npm and, on a project *without* a `package.json`, reported `passed`
 * having asserted nothing; a `must` Rule lost its only enforcement and an archive's mandatory Gate
 * was empty. No number of runs here could have surfaced it, because the harness could not build the
 * shape that triggers it. The tests were shaped so that the defect was invisible to them.
 *
 * Installing outside also matches what XForge itself now documents. v0.7.12 moved the CLI from
 * `npx --no-install` to a global install for exactly this reason: putting a `package.json` and a
 * `node_modules` into a project that is not a Node project is pollution, and the ancestor-install
 * hazard that came with it was real. This harness was the last place still doing the thing the
 * product had already decided was wrong.
 */
export async function installCli({ cliRoot, mode, packRoot, npmCache }) {
  const { spec, version, source } = await resolveInstallSpec({ mode, packRoot });
  await mkdir(cliRoot, { recursive: true });
  /* A private package.json here, in the CLI's own directory — never in the project. */
  await writeFile(
    path.join(cliRoot, 'package.json'),
    `${JSON.stringify({ name: 'xforge-live-engine-cli-host', private: true }, null, 2)}\n`,
  );
  const args = ['install', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', spec];
  const result = spawnSync('npm', args, {
    cwd: cliRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: npmCache ? { ...process.env, npm_config_cache: npmCache } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(`npm install of ${spec} failed (mode=${mode}): ${result.stderr || result.stdout}`);
  }
  const installedCliPath = path.join(cliRoot, 'node_modules', '@xforge', 'cli', 'dist', 'cli.js');
  try {
    await readFile(installedCliPath);
  } catch {
    throw new Error(`@xforge/cli did not install correctly into ${cliRoot} (expected ${installedCliPath}).`);
  }
  return { version, source, installedCliPath, binDirectory: path.join(cliRoot, 'node_modules', '.bin') };
}
