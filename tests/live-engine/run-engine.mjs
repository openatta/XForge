import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { cliBinDirectory } from './xforge-cli.mjs';
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

/*
 * The limits an existing policy must already agree with, and nothing else.
 *
 * `stages` is deliberately absent. `assertLiveEnginePolicy` compares every key it is handed against
 * the policy by identity, and the Stage list lives on `stageIds` while `policy.stages` is the
 * per-Stage attempt record -- so including it compared an array against an object and refused every
 * run that supplied its own policy file.
 */
const policySettings = {
  suiteBudgetUsd: Number(selected['suite-budget']),
  maxAttemptsPerStage: Number(selected['max-attempts']),
  timeoutSeconds: Number(selected['timeout-seconds']),
};
let policy = await readJson(policyPath);
if (policy) {
  assertLiveEnginePolicy(policy, policySettings);
} else {
  /* The Stage this invocation was handed, which is the only one it can spend against. Creating a
     policy without saying so used to fall back to a Stage list that predated the current graphs, so
     running this script directly for one Stage was refused before a single call was made. */
  policy = createLiveEnginePolicy({ ...policySettings, stages: [stage] });
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

/*
 * `stream-json`, not `json`, and the reason is what a live run is for.
 *
 * `--output-format json` returns one result envelope: the final text, the token counts, the cost.
 * What it does not return is what the Agent *did* — which commands it ran, in what order, and
 * whether it followed the instruction under test at all. A run of the `solid` scenario recorded
 * `num_turns: 23` and not one of those turns, so the question "did the Agent use the command this
 * Skill now tells it to use" was unanswerable from a run that had just cost ten dollars to produce.
 *
 * That is the one class of question only a live run can answer, so a harness that discards it is
 * paying for a model call and keeping the receipt. `stream-json` emits one JSON object per message;
 * the last is the same result envelope `json` would have returned, written to the same path in the
 * same shape, so nothing downstream changes. The transcript lands beside it.
 */
/*
 * One session per Change, when asked for it, instead of one per Stage.
 *
 * A Stage costs about 23k tokens of fixed preamble before it reads anything, and it pays that on
 * every turn; a measured `solid` run spent 4.64M of its 6.17M prompt tokens re-sending a preamble
 * that never changed. Seven cold starts also mean seven rebuilds of the same understanding, which
 * is what makes 65-82% of the calls in every measured Stage orientation rather than work.
 *
 * `--session-chain <file>` tests whether that is inherent. The file carries the previous Stage's
 * session id: the first Stage writes one, each later Stage resumes it and arrives already holding
 * the Change it is working on. Session persistence has to be on for that, so `--no-session-persistence`
 * is dropped in this mode and kept in every other -- the default path below is unchanged, because
 * this is the arm of an experiment and not yet a decision.
 */
const sessionChain = selected['session-chain'] ? path.resolve(selected['session-chain']) : null;
const resumeSessionId = sessionChain && existsSync(sessionChain)
  ? (await readFile(sessionChain, 'utf8')).trim() || null
  : null;

const args = [
  '-p',
  '--output-format', 'stream-json',
  /* `stream-json` under `--print` requires it; the CLI refuses the combination otherwise. */
  '--verbose',
  ...(sessionChain ? [] : ['--no-session-persistence']),
  ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
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
  /* The CLI is installed beside the project, not in it, so the Agent finds `xforge` on PATH — the
     global-install form the project's own AGENTS.md tells it to use. Pointing at the project's
     node_modules/.bin would find nothing, and would require the project to be a Node project. */
  PATH: `${cliBinDirectory(projectRoot)}${path.delimiter}${environment.PATH ?? ''}`,
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
  /*
   * The deadline is polled against the clock rather than armed as one `setTimeout(timeoutSeconds)`,
   * and the poll is deliberately not unref'd. A live run had two stages sit on hung provider streams
   * — sockets ESTABLISHED, no bytes, 6 seconds of CPU across 28 minutes — and the single one-shot
   * timer never fired, so a call with no upper bound at all took the whole suite down with it. The
   * mechanism was never identified, and that is the point: a watchdog that re-checks the wall clock
   * every 15 seconds cannot be defeated by one lost or deferred timer, and holding a ref keeps the
   * loop awake to run it. The kill still happens here, in the process that owns the child, so
   * SIGTERM -> SIGKILL escalates against the right pid instead of orphaning `claude`.
   */
  code = await new Promise((resolve) => {
    const deadline = Date.now() + policy.timeoutSeconds * 1_000;
    let forceTimer;
    const watchdog = setInterval(() => {
      if (Date.now() < deadline) return;
      timedOut = true;
      clearInterval(watchdog);
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, 15_000);
    const settle = (value) => { clearInterval(watchdog); if (forceTimer) clearTimeout(forceTimer); resolve(value); };
    child.on('error', (error) => { spawnError = error; settle(1); });
    child.on('close', (status) => settle(status ?? 1));
  });
}

const output = redact(Buffer.concat(stdout).toString('utf8'));
const errorOutput = redact(Buffer.concat(stderr).toString('utf8'));
/*
 * The stream, split into the transcript and the verdict.
 *
 * Every line is one message. The last `type: 'result'` is what `--output-format json` would have
 * returned on its own, and it goes to `outputPath` unchanged so every existing reader — the matrix
 * assertions, `summarize.mjs`, the acceptance check — sees exactly what it saw before. The rest is
 * the evidence that used to be thrown away, written beside it as JSONL.
 *
 * A line that does not parse is kept verbatim rather than dropped: a truncated stream is itself the
 * finding when a provider drops mid-response, and a transcript that silently omits the moment it
 * broke is worse than none.
 */
const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
const messages = [];
let engineResult = null;
for (const line of lines) {
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { messages.push({ type: 'unparsed', line }); continue; }
  messages.push(parsed);
  if (parsed?.type === 'result') engineResult = parsed;
}
const transcriptPath = outputPath.replace(/\.json$/, '') + '-transcript.jsonl';
await writeFile(transcriptPath, messages.length > 0 ? `${messages.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '');

const fallback = {
  type: 'result', subtype: 'runner_error', is_error: true, exitCode: code, timedOut,
  error: redact((spawnError?.message ?? errorOutput) || 'Engine returned no JSON output.'),
};
await writeFile(outputPath, `${JSON.stringify(engineResult ?? fallback, null, 2)}\n`);

/*
 * Hand this Stage's session to the next one, but only on a run that produced a usable session.
 *
 * Written after the result rather than from the `init` record, because a Stage that died is a Stage
 * whose session should not be resumed: continuing into a context that ended in a provider stall
 * would carry the stall's half-finished state into the arm being measured, and the comparison is
 * the whole point of the mode. A failed Stage leaves the chain holding the last good id, so the
 * retry resumes what the failed attempt started from rather than what it left behind.
 */
if (sessionChain && engineResult?.session_id && !engineResult.is_error) {
  await writeFile(sessionChain, `${engineResult.session_id}\n`);
}

const costUsd = typeof engineResult?.total_cost_usd === 'number' ? engineResult.total_cost_usd : null;
/*
 * Tokens, not dollars, are what these runs are reported in. The cost figure is still recorded and
 * still drives the budget stop, but it is a function of whichever engine and rate card served the
 * request, so it is not comparable between runs and says nothing useful to a reader. Token counts
 * are the same quantity whoever answers.
 */
const usage = engineResult?.usage ?? null;
const tokenCount = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const tokens = usage ? {
  input: tokenCount(usage.input_tokens),
  output: tokenCount(usage.output_tokens),
  cacheRead: tokenCount(usage.cache_read_input_tokens),
  cacheCreation: tokenCount(usage.cache_creation_input_tokens),
  total: tokenCount(usage.input_tokens) + tokenCount(usage.output_tokens)
    + tokenCount(usage.cache_read_input_tokens) + tokenCount(usage.cache_creation_input_tokens),
} : null;
const classification = timedOut || spawnError
  ? 'environment_blocked'
  : code !== 0 || engineResult?.is_error === true
    ? 'provider_failure'
    : 'success';
const completed = completeLiveEngineAttempt(policy, {
  stage,
  attempt: reservation.attempt,
  costUsd,
  tokens,
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
  /* Named in the result line so a reader who wants to know what the Agent *did* has the path,
     rather than having to know that this file exists. */
  transcript: transcriptPath,
  policy: policyPath,
  stage,
  attempt: reservation.attempt,
  tokens,
  suiteTokens: completed.tokens,
  isolation,
  classification,
})}\n`);
process.exitCode = ok ? 0 : 1;
