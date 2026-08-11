import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnXforge } from './xforge-cli.mjs';

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const allowedRoot = path.join(repositoryRoot, 'tests', '.tmp');

function options(argv) {
  const result = { suffix: '' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Expected --root, --results, --output, --change and optional --suffix values.');
    result[key.slice(2)] = value;
  }
  for (const key of ['root', 'results', 'output', 'change']) if (!result[key]) throw new Error(`--${key} is required.`);
  return result;
}

function bounded(value, label) {
  const resolved = path.resolve(value);
  if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error(`${label} must be inside ${allowedRoot}.`);
  }
  return resolved;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function jsonResult(execution, label) {
  try { return JSON.parse(execution.stdout); } catch {
    throw new Error(`${label} did not return JSON: ${execution.stdout || execution.stderr}`);
  }
}

async function exists(filePath) {
  try { await stat(filePath); return true; } catch { return false; }
}

const selected = options(process.argv.slice(2));
const projectRoot = await realpath(bounded(selected.root, 'Project root'));
const resultsRoot = await realpath(bounded(selected.results, 'Results directory'));
const outputPath = bounded(selected.output, 'Summary output');
await mkdir(path.dirname(outputPath), { recursive: true });
const policyPath = path.join(resultsRoot, 'live-engine-policy.json');
const runnerPolicy = await exists(policyPath) ? JSON.parse(await readFile(policyPath, 'utf8')) : null;

const suffix = selected.suffix ? `-${selected.suffix}` : '';
const stages = {
  plan: `01-plan${suffix}.json`,
  apply: `02-apply${suffix}.json`,
  verify: `03-verify${suffix}.json`,
};
const engine = {};
for (const [stage, name] of Object.entries(stages)) {
  const value = JSON.parse(await readFile(path.join(resultsRoot, name), 'utf8'));
  engine[stage] = {
    resultPath: path.relative(repositoryRoot, path.join(resultsRoot, name)).split(path.sep).join('/'),
    type: value.type ?? null,
    subtype: value.subtype ?? null,
    isError: value.is_error ?? null,
    durationMs: value.duration_ms ?? null,
    apiDurationMs: value.duration_api_ms ?? null,
    turns: value.num_turns ?? null,
    costUsd: value.total_cost_usd ?? null,
    usage: {
      inputTokens: value.usage?.input_tokens ?? null,
      cacheReadInputTokens: value.usage?.cache_read_input_tokens ?? null,
      outputTokens: value.usage?.output_tokens ?? null,
    },
  };
}

const stateExecution = spawnXforge(projectRoot, ['--root', projectRoot, 'state']);
const state = jsonResult(stateExecution, 'xforge state');
const auditExecution = spawnXforge(projectRoot, ['--root', projectRoot, 'audit', 'verify']);
const audit = jsonResult(auditExecution, 'xforge audit verify');
const acceptance = run('npm', ['test'], projectRoot);
const gitHead = run('git', ['rev-parse', 'HEAD'], projectRoot).stdout.trim();

const archiveRoot = path.join(projectRoot, 'xforge', 'changes', 'archive');
const archiveNames = (await readdir(archiveRoot)).filter((name) => name.endsWith(`-${selected.change}`)).sort();
const archivePath = archiveNames.length > 0 ? path.join(archiveRoot, archiveNames.at(-1)) : null;
const mainSpecPath = path.join(projectRoot, 'xforge', 'specs', `${selected.change}.md`);
let transitionReceipts = 0;
let approvalReceipts = 0;
let delivery = null;
if (archivePath) {
  const transitions = path.join(archivePath, 'evidence', 'receipts', 'transitions');
  if (await exists(transitions)) transitionReceipts = (await readdir(transitions)).filter((name) => name.endsWith('.json')).length;
  const approvals = path.join(archivePath, 'approvals');
  if (await exists(approvals)) {
    for (const policy of await readdir(approvals)) {
      const policyPath = path.join(approvals, policy);
      if ((await stat(policyPath)).isDirectory()) approvalReceipts += (await readdir(policyPath)).filter((name) => name.endsWith('.json')).length;
    }
  }
  const agentRoot = path.join(archivePath, 'evidence', 'agents', 'T001');
  if (await exists(agentRoot)) {
    const deliveryNames = (await readdir(agentRoot)).filter((name) => name.endsWith('.yaml')).sort();
    if (deliveryNames.length > 0) delivery = JSON.parse(await readFile(path.join(agentRoot, deliveryNames.at(-1)), 'utf8'));
  }
}

const engineValues = Object.values(engine);
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  change: selected.change,
  project: path.relative(repositoryRoot, projectRoot).split(path.sep).join('/'),
  outcome: 'pass',
  engine,
  totals: {
    durationMs: engineValues.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
    turns: engineValues.reduce((sum, item) => sum + (item.turns ?? 0), 0),
    costUsd: engineValues.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
    inputTokens: engineValues.reduce((sum, item) => sum + (item.usage.inputTokens ?? 0), 0),
    cacheReadInputTokens: engineValues.reduce((sum, item) => sum + (item.usage.cacheReadInputTokens ?? 0), 0),
    outputTokens: engineValues.reduce((sum, item) => sum + (item.usage.outputTokens ?? 0), 0),
  },
  runnerPolicy: runnerPolicy ? {
    path: path.relative(repositoryRoot, policyPath).split(path.sep).join('/'),
    suiteBudgetUsd: runnerPolicy.suiteBudgetUsd,
    spentUsd: runnerPolicy.spentUsd,
    maxAttemptsPerStage: runnerPolicy.maxAttemptsPerStage,
    timeoutSeconds: runnerPolicy.timeoutSeconds,
    budgetAccountingComplete: runnerPolicy.budgetAccountingComplete,
    attempts: Object.fromEntries(Object.entries(runnerPolicy.stages ?? {}).map(([stage, value]) => [stage, value.attempts])),
  } : null,
  checks: {
    engineStagesSucceeded: engineValues.every((item) => item.subtype === 'success' && item.isError === false),
    acceptanceExitCode: acceptance.exitCode,
    acceptancePassed: Number(acceptance.stdout.match(/# pass (\d+)/)?.[1] ?? 0),
    stateOk: state.ok === true,
    activeChanges: state.data?.changes ?? [],
    mainSpecExists: await exists(mainSpecPath),
    archiveExists: archivePath !== null,
    auditValid: audit.data?.valid === true,
    auditEventCount: audit.data?.eventCount ?? null,
    auditRemotePending: audit.data?.remotePending ?? null,
    transitionReceipts,
    approvalReceipts,
    deliveryChangedPaths: delivery?.changed_paths ?? null,
    gitHead,
  },
};

const passed = summary.checks.engineStagesSucceeded
  && summary.runnerPolicy !== null
  && summary.runnerPolicy.budgetAccountingComplete
  && summary.runnerPolicy.spentUsd <= summary.runnerPolicy.suiteBudgetUsd
  && Object.values(summary.runnerPolicy.attempts).every((attempts) => attempts <= summary.runnerPolicy.maxAttemptsPerStage)
  && summary.checks.acceptanceExitCode === 0
  && summary.checks.stateOk
  && summary.checks.activeChanges.length === 0
  && summary.checks.mainSpecExists
  && summary.checks.archiveExists
  && summary.checks.auditValid
  && summary.checks.transitionReceipts === 4
  && summary.checks.approvalReceipts === 2
  && JSON.stringify(summary.checks.deliveryChangedPaths) === JSON.stringify(['src/cli.mjs']);
summary.outcome = passed ? 'pass' : 'fail';
await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: passed, output: outputPath })}\n`);
process.exitCode = passed ? 0 : 1;
