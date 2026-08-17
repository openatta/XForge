import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
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
   */
  const sharedPackRoot = path.join(repositoryRoot, 'tests', '.tmp', 'live-engine-npm-pack');
  await mkdir(sharedPackRoot, { recursive: true });
  const key = await sourceDigest();
  const existing = path.join(sharedPackRoot, `xforge-cli-${version}-${key}.tgz`);
  if (await readFile(existing).then(() => true, () => false)) {
    return { spec: existing, version, source: 'local-tarball' };
  }
  run('npm', ['run', 'build', '--prefix', 'xforge'], repositoryRoot);
  const packed = JSON.parse(run('npm', [
    'pack', './xforge', '--json', '--ignore-scripts', '--pack-destination', sharedPackRoot,
  ], repositoryRoot));
  /* `npm pack` names the file after the version, which is exactly the name that cannot serve as a
     cache key here. Renaming it to the content-keyed name is what makes the lookup above ever hit,
     and what keeps two differing builds of one version from occupying the same path. */
  await rename(path.join(sharedPackRoot, packed[0]?.filename ?? 'missing.tgz'), existing);
  return { spec: existing, version, source: 'local-tarball' };
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
