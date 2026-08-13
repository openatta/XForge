import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

  await mkdir(packRoot, { recursive: true });
  /*
   * Reuse an already-packed tarball for this version when one is here. Building and packing is the
   * only step of a `--cli-source local` run that touches the shared repository rather than the
   * isolated project, so three Flows starting at once used to run three `npm run build`s against
   * one `xforge/dist` — whose `clean` step deletes it — and knock each other over before a single
   * model call was made. With the pack reused, the Flows share one artifact and can genuinely run
   * in parallel. Delete `tests/.tmp/live-engine-npm-pack` (or run one Flow at a time) to force a
   * rebuild after changing the CLI.
   */
  const existing = path.join(packRoot, `xforge-cli-${version}.tgz`);
  if (await readFile(existing).then(() => true, () => false)) {
    return { spec: existing, version, source: 'local-tarball' };
  }
  run('npm', ['run', 'build', '--prefix', 'xforge'], repositoryRoot);
  const packed = JSON.parse(run('npm', [
    'pack', './xforge', '--json', '--ignore-scripts', '--pack-destination', packRoot,
  ], repositoryRoot));
  const tarball = path.join(packRoot, packed[0]?.filename ?? 'missing.tgz');
  return { spec: tarball, version, source: 'local-tarball' };
}

/**
 * Installs @xforge/cli as an exact pinned devDependency of `projectRoot`, mirroring the
 * documented `npm install --save-dev --save-exact @xforge/cli@<version>` step. Requires
 * `projectRoot/package.json` to already exist.
 */
export async function installCli({ projectRoot, mode, packRoot, npmCache }) {
  const { spec, version, source } = await resolveInstallSpec({ mode, packRoot });
  const args = ['install', '--save-dev', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', spec];
  const result = spawnSync('npm', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: npmCache ? { ...process.env, npm_config_cache: npmCache } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(`npm install of ${spec} failed (mode=${mode}): ${result.stderr || result.stdout}`);
  }
  const installedCliPath = path.join(projectRoot, 'node_modules', '@xforge', 'cli', 'dist', 'cli.js');
  try {
    await readFile(installedCliPath);
  } catch {
    throw new Error(`@xforge/cli did not install correctly into ${projectRoot} (expected ${installedCliPath}).`);
  }
  return { version, source, installedCliPath };
}

export async function writeMinimalPackageJson(projectRoot, name) {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, 'package.json'),
    `${JSON.stringify({ name, private: true }, null, 2)}\n`,
  );
}
