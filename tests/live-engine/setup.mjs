import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installCli } from './cli-source.mjs';
import { parse as parseYaml, stringify as stringifyYaml } from '../../xforge/node_modules/yaml/dist/index.js';

/* fileURLToPath, not .pathname + path.resolve: a file:// URL's .pathname keeps a leading
   slash before a Windows drive letter (/D:/...), which path.resolve does not strip -- it
   prepends the cwd's own drive instead, producing a broken D:\D:\... path. */
const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
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
  if (!result.scenario) throw new Error('--scenario is required (it names the isolated project this run owns).');
  /* The scenario names the project; the seed names the directory its fixtures come from. They are
     the same for a scenario that owns its fixtures, and differ for one that shares another's -- so
     `solid-rework` seeds from `solid` while keeping a project, temp root and results of its own. */
  result.seed ??= result.scenario;
  if (!['npm', 'local'].includes(result['cli-source'])) throw new Error('--cli-source must be npm or local.');
  return result;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/* Same, with an explicit environment — the CLI now lives on PATH rather than in the project. */
function runWithEnv(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

/**
 * A seed's `package.json` is now the only one a project gets.
 *
 * The harness used to write one first (to install the CLI as a devDependency) and merge the seed
 * into it. With the CLI installed outside the project there is nothing to merge into, and there
 * must not be: a project that declares no `package.json` has to end up without one, or the harness
 * is back to making every scenario a Node project. A seed that ships one still gets it verbatim.
 */
async function mergePackageJson(projectRoot, seedPackageJsonPath) {
  const currentPath = path.join(projectRoot, 'package.json');
  const seed = JSON.parse(await readFile(seedPackageJsonPath, 'utf8'));
  const current = await exists(currentPath) ? JSON.parse(await readFile(currentPath, 'utf8')) : {};
  const merged = {
    ...current,
    ...seed,
    private: true,
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
 *  - The scaffold ships `enterprise-approvals` as a deliberately-broken placeholder McpServer
 *    (`command` points at a binary that does not exist) so a real deployment fails loudly instead
 *    of silently working. The harness is exactly the "real approval system" an adopting org is
 *    meant to point that placeholder at, so it overwrites `command` to the MCP test fixture already
 *    used by the internal test suite (`xforge/test/fixtures/mcp-approval-server.mjs`).
 *
 * This is now the *only* mechanism the harness drives. The manifest switch that used to let a piped
 * stdin substitute for a controlling terminal was removed from the product — a switch that relaxes
 * governance while living inside the tree the governed Agent writes lets the Agent decide whether
 * governance applies to it — so `approval-provider.mjs` prefers mcp for every policy that offers it,
 * which the shipped policies all do.
 */
async function enableApprovalHarness(projectRoot) {
  const mcpServerPath = path.join(projectRoot, 'xforge', 'scaffold', 'mcp-servers', 'enterprise-approvals.yaml');
  if (await exists(mcpServerPath)) {
    const server = parseYaml(await readFile(mcpServerPath, 'utf8'));
    const fixture = path.join(repositoryRoot, 'xforge', 'test', 'fixtures', 'mcp-approval-server.mjs');
    server.spec.command = [process.execPath, fixture];
    /* core/mcp-approval.ts hands the provider subprocess a filtered environment, not `process.env`,
       so the fixture's XFORGE_TEST_MCP_* controls have to be declared here or they are stripped and
       the fixture silently falls back to its `pending` default. That filtering is the product
       behaving correctly; it only surfaced once the harness started preferring the mcp mechanism. */
    server.spec.env = { ...server.spec.env, allowPrefixes: ['XFORGE_TEST_MCP_'] };
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
const scenarioRoot = path.join(scenariosRoot, selected.seed);
if (!await exists(scenarioRoot)) throw new Error(`Unknown seed: ${selected.seed} (expected ${scenarioRoot}).`);
const projectRoot = path.join(temporaryRoot, `live-engine-${selected.scenario}`);

await rm(projectRoot, { recursive: true, force: true });
const claudeConfigRoot = path.join(scenarioTempRoot(selected.scenario), 'claude-config');
const packRoot = path.join(scenarioTempRoot(selected.scenario), 'npm-pack');
await mkdir(claudeConfigRoot, { recursive: true });
await mkdir(projectRoot, { recursive: true });

/*
 * The CLI is installed beside the project, never inside it. Installing it as a devDependency meant
 * writing a `package.json` into the project first, which made every scenario this harness can build
 * a Node project — and that is precisely the shape in which the shipped npm Gates reported `passed`
 * without asserting anything. A harness that cannot construct the failing shape cannot see the
 * failure. The project now starts empty and gets only what its seed puts there.
 */
const cli = await installCli({
  cliRoot: path.join(scenarioTempRoot(selected.scenario), 'cli'),
  mode: selected['cli-source'],
  packRoot,
  npmCache: process.env.XFORGE_LIVE_ENGINE_NPM_CACHE,
});

/* Invoked as a bare `xforge` off PATH — the global-install form v0.7.12 documents, and the same
   form the project's own AGENTS.md tells an Agent to use. */
const cliEnv = { ...process.env, PATH: `${cli.binDirectory}${path.delimiter}${process.env.PATH ?? ''}` };
runWithEnv('xforge', ['--root', projectRoot, 'init', '--language', 'en', '--target', 'claude'], projectRoot, cliEnv);
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
  cliBin: cli.binDirectory,
})}\n`);
