import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installCli, writeMinimalPackageJson } from './cli-source.mjs';
import { parse as parseYaml, stringify as stringifyYaml } from '../../xforge/node_modules/yaml/dist/index.js';

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const temporaryRoot = path.join(repositoryRoot, 'tests', '.tmp');
const scenariosRoot = path.join(repositoryRoot, 'tests', 'live-engine', 'scenarios');
/* Per scenario, not shared: two concurrent setups would `npm pack` the same tarball path and one
   would install a half-written file, and two concurrent engines would share a CLAUDE_CONFIG_DIR.
   Scoping both by scenario is what makes `--flow quick|solid|major` safe to run in parallel. */
const scenarioTempRoot = (scenario) => path.join(temporaryRoot, `live-engine-${scenario}-tmp`);

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

/**
 * Wires the shipped scaffold's approval mechanisms to something the harness can actually decide
 * against, without touching any Flow's policy definitions (`major.yaml` etc. are exercised exactly
 * as shipped):
 *  - `approvals.local.requireTty: false` lets `approval-provider.mjs` drive a local approval by
 *    spawning `xforge approve` with piped stdin instead of a real controlling terminal — the CLI
 *    still requires the decision to be typed into that stream, it just accepts a piped one here.
 *  - The scaffold ships `enterprise-approvals` as a deliberately-broken placeholder McpServer
 *    (`command` points at a binary that does not exist) so a real deployment fails loudly instead
 *    of silently working. The harness is exactly the "real approval system" an adopting org is
 *    meant to point that placeholder at, so it overwrites `command` to the MCP test fixture already
 *    used by the internal test suite (`xforge/test/fixtures/mcp-approval-server.mjs`).
 *    `approval-provider.mjs` routes to this fixture only when a policy does not list `local`; the
 *    shipped Major policies (`implementation-major`/`closing-major`) currently list `local` first,
 *    so in the shipped scaffolds they are driven through the piped-stdin dialogue instead.
 */
async function enableApprovalHarness(projectRoot) {
  const manifestPath = path.join(projectRoot, 'xforge', 'manifest.yaml');
  const manifest = parseYaml(await readFile(manifestPath, 'utf8'));
  manifest.approvals ??= { providers: [] };
  manifest.approvals.local = { ...manifest.approvals.local, requireTty: false };
  await writeFile(manifestPath, stringifyYaml(manifest));

  const mcpServerPath = path.join(projectRoot, 'xforge', 'scaffold', 'mcp-servers', 'enterprise-approvals.yaml');
  if (await exists(mcpServerPath)) {
    const server = parseYaml(await readFile(mcpServerPath, 'utf8'));
    const fixture = path.join(repositoryRoot, 'xforge', 'test', 'fixtures', 'mcp-approval-server.mjs');
    server.spec.command = [process.execPath, fixture];
    await writeFile(mcpServerPath, stringifyYaml(server));
  }
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
const claudeConfigRoot = path.join(scenarioTempRoot(selected.scenario), 'claude-config');
const packRoot = path.join(scenarioTempRoot(selected.scenario), 'npm-pack');
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
await enableApprovalHarness(projectRoot);

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
