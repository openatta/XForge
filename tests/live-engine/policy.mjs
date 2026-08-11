// The default 3-stage set kept for backward compatibility with the original Solid-only
// runbook. `createLiveEnginePolicy`/`assertLiveEnginePolicy` accept any non-empty stage id
// list now, so Quick/Major stage graphs (which differ from Solid's) are not hardcoded here.
export const LIVE_ENGINE_STAGES = ['plan', 'apply', 'verify'];

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

export function completeLiveEngineAttempt(policy, {
  stage, attempt, costUsd, exitCode, timedOut, classification, output, finishedAt,
}) {
  assertLiveEnginePolicy(policy);
  const entry = stageEntry(policy, stage);
  const run = entry.runs.find((candidate) => candidate.attempt === attempt);
  if (!run || run.status !== 'running') {
    throw new LiveEnginePolicyError('LIVE_ATTEMPT_INVALID', `Stage ${stage} attempt ${attempt} is not running.`);
  }
  const numericCost = Number(costUsd);
  const knownCost = costUsd !== null && costUsd !== undefined && Number.isFinite(numericCost) && numericCost >= 0;
  if (knownCost) policy.spentUsd = rounded(policy.spentUsd + numericCost);
  else policy.budgetAccountingComplete = false;
  Object.assign(run, {
    status: exitCode === 0 && !timedOut ? 'completed' : 'failed',
    costUsd: knownCost ? numericCost : null,
    exitCode,
    timedOut,
    classification,
    output,
    finishedAt,
  });
  return { spentUsd: policy.spentUsd, budgetAccountingComplete: policy.budgetAccountingComplete };
}
