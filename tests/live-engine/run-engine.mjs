import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  assertLiveEnginePolicy,
  completeLiveEngineAttempt,
  createLiveEnginePolicy,
  reserveLiveEngineAttempt,
} from './policy.mjs';

/* fileURLToPath, not .pathname + path.resolve: a file:// URL's .pathname keeps a leading
   slash before a Windows drive letter (/D:/...), which path.resolve does not strip -- it
   prepends the cwd's own drive instead, producing a broken D:\D:\... path. */
const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const allowedRoot = path.join(repositoryRoot, 'tests', '.tmp');
const promptRoot = path.join(repositoryRoot, 'tests', 'live-engine', 'scenarios');
/* Must match setup.mjs's per-scenario root, or parallel engines share one Claude config dir.
   Falls back to the original shared path when the scenario is not set, so a run whose setup
   predates this change keeps finding its existing config instead of silently re-authenticating. */
const claudeConfigRoot = process.env.XFORGE_LIVE_ENGINE_SCENARIO
  ? path.join(allowedRoot, `live-engine-${process.env.XFORGE_LIVE_ENGINE_SCENARIO}-tmp`, 'claude-config')
  : path.join(allowedRoot, 'live-engine-claude-config');

function options(argv) {
  const result = { budget: '3', 'suite-budget': '9', 'max-attempts': '2', 'timeout-seconds': '900' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Expected key/value command-line options.');
    result[key.slice(2)] = value;
  }
  if (!result.root || !result.prompt || !result.output) throw new Error('--root, --prompt and --output are required.');
  if (!result['sandbox-launcher'] && result['allow-behavioral-isolation'] !== 'true') {
    throw new Error('Provide --sandbox-launcher or explicitly acknowledge --allow-behavioral-isolation true.');
  }
  return result;
}

function dotenv(source) {
  const result = {};
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function bounded(value, label) {
  const resolved = path.resolve(value);
  if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error(`${label} must be inside ${allowedRoot}.`);
  }
  return resolved;
}

function inferStage(output) {
  const name = path.basename(output);
  if (/^01-plan(?:-|\.)/.test(name)) return 'plan';
  if (/^02-apply(?:-|\.)/.test(name)) return 'apply';
  if (/^03-verify(?:-|\.)/.test(name)) return 'verify';
  throw new Error('Unable to infer stage from output; pass --stage plan|apply|verify.');
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

function redactor(configured) {
  const secrets = [configured.ANTHROPIC_AUTH_TOKEN, configured.ANTHROPIC_BASE_URL].filter(Boolean);
  return (source) => secrets.reduce((value, secret) => value.split(secret).join('[REDACTED]'), source);
}

const selected = options(process.argv.slice(2));
const projectRoot = await realpath(bounded(selected.root, 'Engine project'));
const promptPath = await realpath(path.resolve(selected.prompt));
if (!promptPath.startsWith(`${await realpath(promptRoot)}${path.sep}`)) throw new Error(`Prompt must be inside ${promptRoot}.`);
const outputPath = bounded(selected.output, 'Engine output');
const policyPath = bounded(selected.policy ?? path.join(path.dirname(outputPath), 'live-engine-policy.json'), 'Policy file');
const stage = selected.stage ?? inferStage(outputPath);

const configured = dotenv(await readFile(path.join(repositoryRoot, '.env'), 'utf8'));
for (const required of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
  if (!configured[required]) throw new Error(`Missing required engine setting: ${required}`);
}
const redact = redactor(configured);
const prompt = await readFile(promptPath, 'utf8');
await mkdir(path.dirname(outputPath), { recursive: true });
await mkdir(claudeConfigRoot, { recursive: true });

const policySettings = {
  suiteBudgetUsd: Number(selected['suite-budget']),
  maxAttemptsPerStage: Number(selected['max-attempts']),
  timeoutSeconds: Number(selected['timeout-seconds']),
};
let policy = await readJson(policyPath);
if (policy) {
  assertLiveEnginePolicy(policy, policySettings);
} else {
  policy = createLiveEnginePolicy(policySettings);
}
const isolation = selected['sandbox-launcher'] ? 'external-launcher' : 'behavioral';
const startedAt = new Date().toISOString();
const reservation = reserveLiveEngineAttempt(policy, {
  stage,
  requestedBudgetUsd: Number(selected.budget),
  isolation,
  startedAt,
});
await atomicJson(policyPath, policy);

const args = [
  '-p',
  '--output-format', 'json',
  '--no-session-persistence',
  '--dangerously-skip-permissions',
  '--max-budget-usd', String(reservation.effectiveBudgetUsd),
];
if (configured.ANTHROPIC_MODEL) args.push('--model', configured.ANTHROPIC_MODEL);
if (configured.CLAUDE_CODE_EFFORT_LEVEL) args.push('--effort', configured.CLAUDE_CODE_EFFORT_LEVEL);
args.push(prompt);

const environment = {};
for (const name of ['PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL']) {
  if (process.env[name]) environment[name] = process.env[name];
}
for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL']) {
  if (configured[name]) environment[name] = configured[name];
}
Object.assign(environment, {
  CLAUDE_CONFIG_DIR: claudeConfigRoot,
  HOME: claudeConfigRoot,
  USERPROFILE: claudeConfigRoot,
  XDG_CACHE_HOME: path.join(claudeConfigRoot, 'cache'),
  XDG_CONFIG_HOME: path.join(claudeConfigRoot, 'config'),
  PATH: `${path.join(projectRoot, 'node_modules', '.bin')}${path.delimiter}${environment.PATH ?? ''}`,
});

const executable = selected['sandbox-launcher'] ? path.resolve(selected['sandbox-launcher']) : 'claude';
const commandArguments = selected['sandbox-launcher'] ? ['claude', ...args] : args;
let child;
let spawnError = null;
try {
  child = spawn(executable, commandArguments, {
    cwd: projectRoot, env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  spawnError = error;
}
const stdout = [];
const stderr = [];
let timedOut = false;
let code = 1;
if (child) {
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  code = await new Promise((resolve) => {
    let forceTimer;
    const stillAlive = () => child.exitCode === null && child.signalCode === null;
    const timeout = setTimeout(() => {
      /*
       * A timer that only gets serviced after the child already exited (observed: the whole
       * machine slept for part of the window and the timer fired once the OS woke up, a moment
       * after the child finished on its own) must not stamp a completed run as timed out — the
       * close handler below owns the verdict in that case.
       */
      if (!stillAlive()) return;
      timedOut = true;
      child.kill('SIGTERM');
      process.stderr.write(`[live-engine] ${stage} exceeded ${policy.timeoutSeconds}s; sent SIGTERM (pid ${child.pid}).\n`);
      forceTimer = setTimeout(() => { if (stillAlive()) child.kill('SIGKILL'); }, 5_000);
    }, policy.timeoutSeconds * 1_000);
    /* Deliberately ref'd: the timers must stay armed and fire on schedule even if the child dies
       in a way that leaves the loop with no other ref'd handle. The close handler clears both, so
       there is no leak. */
    child.on('error', (error) => { spawnError = error; clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer); resolve(1); });
    child.on('close', (status) => { clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer); resolve(status ?? 1); });
  });
}

const output = redact(Buffer.concat(stdout).toString('utf8'));
const errorOutput = redact(Buffer.concat(stderr).toString('utf8'));
let engineResult = null;
try { engineResult = JSON.parse(output); } catch {}
const fallback = {
  type: 'result', subtype: 'runner_error', is_error: true, exitCode: code, timedOut,
  error: redact((spawnError?.message ?? errorOutput) || 'Engine returned no JSON output.'),
};
await writeFile(outputPath, output || `${JSON.stringify(fallback, null, 2)}\n`);

const costUsd = typeof engineResult?.total_cost_usd === 'number' ? engineResult.total_cost_usd : null;
const classification = timedOut || spawnError
  ? 'environment_blocked'
  : code !== 0 || engineResult?.is_error === true
    ? 'provider_failure'
    : 'success';
const completed = completeLiveEngineAttempt(policy, {
  stage,
  attempt: reservation.attempt,
  costUsd,
  exitCode: code,
  timedOut,
  classification,
  output: path.relative(repositoryRoot, outputPath).split(path.sep).join('/'),
  finishedAt: new Date().toISOString(),
});
await atomicJson(policyPath, policy);

if (errorOutput) process.stderr.write(errorOutput);
const ok = code === 0 && !timedOut && engineResult?.is_error !== true && completed.budgetAccountingComplete;
process.stdout.write(`${JSON.stringify({
  ok,
  exitCode: code,
  output: outputPath,
  policy: policyPath,
  stage,
  attempt: reservation.attempt,
  costUsd,
  suiteSpentUsd: completed.spentUsd,
  suiteBudgetUsd: policy.suiteBudgetUsd,
  isolation,
  classification,
})}\n`);
process.exitCode = ok ? 0 : 1;
