import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installCli, writeMinimalPackageJson } from './cli-source.mjs';

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const temporaryRoot = path.join(repositoryRoot, 'tests', '.tmp');
const scenariosRoot = path.join(repositoryRoot, 'tests', 'live-engine', 'scenarios');
const claudeConfigRoot = path.join(temporaryRoot, 'live-engine-claude-config');
const packRoot = path.join(temporaryRoot, 'live-engine-npm-pack');

function options(argv) {
  const result = { 'cli-source': 'npm' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Expected --scenario and optional --cli-source key/value options.');
    result[key.slice(2)] = value;
  }
  if (!result.scenario) throw new Error('--scenario is required (a directory name under tests/live-engine/scenarios).');
  if (!['npm', 'local'].includes(result['cli-source'])) throw new Error('--cli-source must be npm or local.');
  return result;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function mergePackageJson(projectRoot, seedPackageJsonPath) {
  const currentPath = path.join(projectRoot, 'package.json');
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  const seed = JSON.parse(await readFile(seedPackageJsonPath, 'utf8'));
  const merged = {
    ...current,
    ...seed,
    name: current.name,
    private: true,
    devDependencies: current.devDependencies,
    scripts: { ...current.scripts, ...seed.scripts },
  };
  await writeFile(currentPath, `${JSON.stringify(merged, null, 2)}\n`);
}

async function mergeGitignore(projectRoot, seedGitignorePath) {
  const currentPath = path.join(projectRoot, '.gitignore');
  const current = await exists(currentPath) ? await readFile(currentPath, 'utf8') : '';
  const seed = await readFile(seedGitignorePath, 'utf8');
  const lines = new Set([...current.split('\n'), ...seed.split('\n')].map((line) => line.trim()).filter(Boolean));
  await writeFile(currentPath, `${[...lines].join('\n')}\n`);
}

async function overlaySeed(projectRoot, seedRoot) {
  if (!await exists(seedRoot)) return;
  const packageJsonSeed = path.join(seedRoot, 'package.json');
  if (await exists(packageJsonSeed)) await mergePackageJson(projectRoot, packageJsonSeed);
  const gitignoreSeed = path.join(seedRoot, '.gitignore');
  if (await exists(gitignoreSeed)) await mergeGitignore(projectRoot, gitignoreSeed);
  for (const entry of await readdir(seedRoot)) {
    if (entry === 'package.json' || entry === '.gitignore') continue;
    await cp(path.join(seedRoot, entry), path.join(projectRoot, entry), { recursive: true, force: true });
  }
}

const selected = options(process.argv.slice(2));
const scenarioRoot = path.join(scenariosRoot, selected.scenario);
if (!await exists(scenarioRoot)) throw new Error(`Unknown scenario: ${selected.scenario} (expected ${scenarioRoot}).`);
const projectRoot = path.join(temporaryRoot, `live-engine-${selected.scenario}`);

await rm(projectRoot, { recursive: true, force: true });
await mkdir(claudeConfigRoot, { recursive: true });
await writeMinimalPackageJson(projectRoot, `live-engine-${selected.scenario}`);
await writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/\n');

const cli = await installCli({
  projectRoot,
  mode: selected['cli-source'],
  packRoot,
  npmCache: process.env.XFORGE_LIVE_ENGINE_NPM_CACHE,
});

run('npx', ['--no-install', 'xforge', '--root', projectRoot, 'init', '--language', 'en', '--target', 'claude'], projectRoot);

await overlaySeed(projectRoot, path.join(scenarioRoot, 'project-seed'));

run('git', ['init', '--quiet', '--initial-branch=main'], projectRoot);
run('git', ['config', 'user.name', 'XForge Live E2E'], projectRoot);
run('git', ['config', 'user.email', 'xforge-live@example.test'], projectRoot);
run('git', ['add', '.'], projectRoot);
run('git', ['commit', '--quiet', '-m', `Seed live engine scenario: ${selected.scenario}`], projectRoot);

process.stdout.write(`${JSON.stringify({
  ok: true,
  project: projectRoot,
  scenario: selected.scenario,
  cliSource: cli.source,
  cliVersion: cli.version,
})}\n`);
