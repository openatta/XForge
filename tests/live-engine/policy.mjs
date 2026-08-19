// The default 3-stage set kept for backward compatibility with the original Solid-only
// runbook. `createLiveEnginePolicy`/`assertLiveEnginePolicy` accept any non-empty stage id
// list now, so Quick/Major stage graphs (which differ from Solid's) are not hardcoded here.
export const LIVE_ENGINE_STAGES = ['plan', 'apply', 'verify'];

/** Below this round-trip, the shipped per-stage timeout stands unchanged. */
export const PROBE_BASELINE_MS = 3_000;
/** A provider slower than this multiple is a problem to report, not one to wait out. */
export const PROBE_MAX_SCALE = 4;

/**
 * How much to lengthen the per-stage timeout for the provider this run is actually configured with.
 *
 * The ceiling is a bet on provider speed, and a fixed one lost on a real endpoint: `major`'s check
 * stage runs 49 turns, and at the ~7s per turn this project's configured gateway delivers, its API
 * time alone is 5.8 minutes — so 900s could not absorb one slow turn, and the stage was killed twice
 * at exactly 900s having produced nothing. Roughly 95% of a stage's wall clock is time waiting on
 * the provider, so one trivial round trip predicts the ceiling well enough to size it.
 *
 * Only ever lengthens (`max(1, …)`): a fast provider does not get a tighter deadline than the one
 * shipped, because the default encodes more than latency. `null` — the probe could not be made —
 * leaves the default alone rather than guessing in either direction.
 */
export function timeoutScaleForLatency(probedLatencyMs) {
  if (probedLatencyMs === null || !Number.isFinite(probedLatencyMs) || probedLatencyMs <= 0) return 1;
  return Math.min(PROBE_MAX_SCALE, Math.max(1, Math.ceil(probedLatencyMs / PROBE_BASELINE_MS)));
}

export class LiveEnginePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiveEnginePolicyError';
    this.code = code;
  }
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new LiveEnginePolicyError('LIVE_POLICY_INVALID', `${name} must be a positive number.`);
  }
  return parsed;
}

function positiveInteger(value, name) {
  const parsed = positiveNumber(value, name);
  if (!Number.isInteger(parsed)) {
    throw new LiveEnginePolicyError('LIVE_POLICY_INVALID', `${name} must be an integer.`);
  }
  return parsed;
}

function stageEntry(policy, stage) {
  if (!policy.stageIds?.includes(stage)) {
    throw new LiveEnginePolicyError('LIVE_STAGE_INVALID', `Unknown live-engine stage: ${stage}`);
  }
  const entry = policy.stages?.[stage];
  if (!entry) throw new LiveEnginePolicyError('LIVE_POLICY_INVALID', `Policy is missing stage: ${stage}`);
  return entry;
}

function rounded(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function createLiveEnginePolicy({
  suiteBudgetUsd = 9, maxAttemptsPerStage = 2, timeoutSeconds = 900, stages = LIVE_ENGINE_STAGES,
} = {}) {
  if (!Array.isArray(stages) || stages.length === 0 || stages.some((stage) => typeof stage !== 'string' || !stage)) {
    throw new LiveEnginePolicyError('LIVE_POLICY_INVALID', 'stages must be a non-empty array of stage id strings.');
  }
  return {
    schemaVersion: 1,
    stageIds: [...stages],
    suiteBudgetUsd: positiveNumber(suiteBudgetUsd, 'suiteBudgetUsd'),
    maxAttemptsPerStage: positiveInteger(maxAttemptsPerStage, 'maxAttemptsPerStage'),
    timeoutSeconds: positiveInteger(timeoutSeconds, 'timeoutSeconds'),
    spentUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
    budgetAccountingComplete: true,
    stages: Object.fromEntries(stages.map((stage) => [stage, { attempts: 0, runs: [] }])),
  };
}

export function assertLiveEnginePolicy(policy, expected = {}) {
  if (
    policy?.schemaVersion !== 1
    || typeof policy?.stages !== 'object'
    || !Array.isArray(policy?.stageIds)
    || policy.stageIds.length === 0
  ) {
    throw new LiveEnginePolicyError('LIVE_POLICY_INVALID', 'Live-engine policy has an unsupported shape.');
  }
  positiveNumber(policy.suiteBudgetUsd, 'suiteBudgetUsd');
  positiveInteger(policy.maxAttemptsPerStage, 'maxAttemptsPerStage');
  positiveInteger(policy.timeoutSeconds, 'timeoutSeconds');
  for (const stage of policy.stageIds) stageEntry(policy, stage);
  for (const [name, value] of Object.entries(expected)) {
    if (value !== undefined && policy[name] !== value) {
      throw new LiveEnginePolicyError('LIVE_POLICY_MISMATCH', `${name} differs from the existing live-engine policy.`);
    }
  }
  return policy;
}

export function reserveLiveEngineAttempt(policy, { stage, requestedBudgetUsd, isolation, startedAt }) {
  assertLiveEnginePolicy(policy);
  if (!policy.budgetAccountingComplete) {
    throw new LiveEnginePolicyError('LIVE_BUDGET_UNKNOWN', 'A prior attempt has unknown cost; refusing another provider call.');
  }
  if (Object.values(policy.stages).some((entry) => entry.runs.some((run) => run.status === 'running'))) {
    throw new LiveEnginePolicyError('LIVE_ATTEMPT_UNFINISHED', 'A prior attempt is still marked running; refusing another provider call.');
  }
  const entry = stageEntry(policy, stage);
  if (entry.attempts >= policy.maxAttemptsPerStage) {
    throw new LiveEnginePolicyError('LIVE_RETRY_LIMIT', `Stage ${stage} reached its attempt limit.`);
  }
  const remainingUsd = rounded(policy.suiteBudgetUsd - policy.spentUsd);
  if (remainingUsd <= 0) {
    throw new LiveEnginePolicyError('LIVE_SUITE_BUDGET_EXHAUSTED', 'The live-engine suite budget is exhausted.');
  }
  const effectiveBudgetUsd = rounded(Math.min(positiveNumber(requestedBudgetUsd, 'requestedBudgetUsd'), remainingUsd));
  const attempt = entry.attempts + 1;
  entry.attempts = attempt;
  entry.runs.push({
    attempt,
    status: 'running',
    isolation,
    budgetUsd: effectiveBudgetUsd,
    startedAt,
  });
  return { attempt, effectiveBudgetUsd, remainingBeforeUsd: remainingUsd };
}

/**
 * Reopens the attempt budget for Stages a rework sent the Flow back through.
 *
 * `maxAttemptsPerStage` bounds retries of a call that failed, but the counter is keyed by Stage id
 * alone, so a re-traversal spends the same budget: a live Major run reworked check -> propose, which
 * was propose's second visit and therefore its last attempt, and the first provider stall on it
 * ended the Flow with no retry available. A Stage entered again after a rework is a new visit, not a
 * retry of the visit before it. Every completed run stays in `runs` — this resets what may still be
 * spent, and hides nothing that was.
 */
export function resetLiveEngineStageAttempts(policy, stages) {
  assertLiveEnginePolicy(policy);
  for (const stage of stages) {
    const entry = policy.stages?.[stage];
    if (!entry || entry.runs.some((run) => run.status === 'running')) continue;
    entry.attempts = 0;
  }
}

export function completeLiveEngineAttempt(policy, {
  stage, attempt, costUsd, tokens, exitCode, timedOut, classification, output, finishedAt,
}) {
  assertLiveEnginePolicy(policy);
  const entry = stageEntry(policy, stage);
  /* Matched on `status` as well as `attempt`, because a rework reopens the counter and a Stage's
     second visit numbers its attempts from 1 again. Looking up by number alone found the completed
     run from the visit before and rejected a call that had just succeeded. Only one run is ever
     `running` — `reserveLiveEngineAttempt` refuses to start a second — so this is unambiguous. */
  const run = entry.runs.find((candidate) => candidate.attempt === attempt && candidate.status === 'running');
  if (!run) {
    throw new LiveEnginePolicyError('LIVE_ATTEMPT_INVALID', `Stage ${stage} attempt ${attempt} is not running.`);
  }
  const numericCost = Number(costUsd);
  const knownCost = costUsd !== null && costUsd !== undefined && Number.isFinite(numericCost) && numericCost >= 0;
  if (knownCost) policy.spentUsd = rounded(policy.spentUsd + numericCost);
  else policy.budgetAccountingComplete = false;
  /* Cost still drives the budget stop — that is the guardrail — but tokens are what a reader can
     actually compare, since the dollar figure depends on whichever engine and rate card produced
     it. Both are recorded; only tokens are reported. */
  if (tokens) {
    policy.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
    for (const key of ['input', 'output', 'cacheRead', 'cacheCreation', 'total']) {
      policy.tokens[key] += Number(tokens[key] ?? 0);
    }
  }
  Object.assign(run, {
    status: exitCode === 0 && !timedOut ? 'completed' : 'failed',
    costUsd: knownCost ? numericCost : null,
    tokens: tokens ?? null,
    exitCode,
    timedOut,
    classification,
    output,
    finishedAt,
  });
  return { spentUsd: policy.spentUsd, tokens: policy.tokens ?? null, budgetAccountingComplete: policy.budgetAccountingComplete };
}
