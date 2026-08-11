import { describe, expect, it } from 'vitest';
import {
  completeLiveEngineAttempt,
  createLiveEnginePolicy,
  reserveLiveEngineAttempt,
} from './live-engine/policy.mjs';

describe('live-engine suite policy', () => {
  it('caps a provider call to the remaining suite budget', () => {
    const policy = createLiveEnginePolicy({ suiteBudgetUsd: 5, maxAttemptsPerStage: 2, timeoutSeconds: 60 });
    const first = reserveLiveEngineAttempt(policy, {
      stage: 'plan', requestedBudgetUsd: 3, isolation: 'external-launcher', startedAt: '2026-08-09T00:00:00.000Z',
    });
    completeLiveEngineAttempt(policy, {
      stage: 'plan', attempt: first.attempt, costUsd: 2.75, exitCode: 0, timedOut: false,
      classification: 'success', output: '01-plan.json', finishedAt: '2026-08-09T00:01:00.000Z',
    });
    const second = reserveLiveEngineAttempt(policy, {
      stage: 'apply', requestedBudgetUsd: 3, isolation: 'external-launcher', startedAt: '2026-08-09T00:02:00.000Z',
    });
    expect(second.effectiveBudgetUsd).toBe(2.25);
  });

  it('enforces the per-stage retry limit', () => {
    const policy = createLiveEnginePolicy({ suiteBudgetUsd: 9, maxAttemptsPerStage: 1, timeoutSeconds: 60 });
    const reserved = reserveLiveEngineAttempt(policy, {
      stage: 'verify', requestedBudgetUsd: 3, isolation: 'behavioral', startedAt: '2026-08-09T00:00:00.000Z',
    });
    completeLiveEngineAttempt(policy, {
      stage: 'verify', attempt: reserved.attempt, costUsd: 1, exitCode: 1, timedOut: false,
      classification: 'model_behavior_failure', output: '03-verify.json', finishedAt: '2026-08-09T00:01:00.000Z',
    });
    expect(() => reserveLiveEngineAttempt(policy, {
      stage: 'verify', requestedBudgetUsd: 3, isolation: 'behavioral', startedAt: '2026-08-09T00:02:00.000Z',
    })).toThrow(expect.objectContaining({ code: 'LIVE_RETRY_LIMIT' }));
  });

  it('fails closed when a provider result has no cost accounting', () => {
    const policy = createLiveEnginePolicy();
    const reserved = reserveLiveEngineAttempt(policy, {
      stage: 'apply', requestedBudgetUsd: 3, isolation: 'behavioral', startedAt: '2026-08-09T00:00:00.000Z',
    });
    completeLiveEngineAttempt(policy, {
      stage: 'apply', attempt: reserved.attempt, costUsd: null, exitCode: 1, timedOut: true,
      classification: 'environment_blocked', output: '02-apply.json', finishedAt: '2026-08-09T00:01:00.000Z',
    });
    expect(policy.budgetAccountingComplete).toBe(false);
    expect(() => reserveLiveEngineAttempt(policy, {
      stage: 'verify', requestedBudgetUsd: 3, isolation: 'behavioral', startedAt: '2026-08-09T00:02:00.000Z',
    })).toThrow(expect.objectContaining({ code: 'LIVE_BUDGET_UNKNOWN' }));
  });

  it('supports a custom stage list for Flow graphs that differ from the default plan/apply/verify set', () => {
    const majorStages = ['propose', 'clarify', 'design', 'check', 'apply', 'verify'];
    const policy = createLiveEnginePolicy({ suiteBudgetUsd: 20, maxAttemptsPerStage: 2, timeoutSeconds: 900, stages: majorStages });
    expect(policy.stageIds).toEqual(majorStages);
    const reserved = reserveLiveEngineAttempt(policy, {
      stage: 'clarify', requestedBudgetUsd: 2, isolation: 'behavioral', startedAt: '2026-08-09T00:00:00.000Z',
    });
    expect(reserved.attempt).toBe(1);
    completeLiveEngineAttempt(policy, {
      stage: 'clarify', attempt: reserved.attempt, costUsd: 1, exitCode: 0, timedOut: false,
      classification: 'success', output: 'clarify.json', finishedAt: '2026-08-09T00:00:30.000Z',
    });
    expect(() => reserveLiveEngineAttempt(policy, {
      stage: 'apply-with-typo', requestedBudgetUsd: 2, isolation: 'behavioral', startedAt: '2026-08-09T00:01:00.000Z',
    })).toThrow(expect.objectContaining({ code: 'LIVE_STAGE_INVALID' }));
  });

  it('rejects an empty stage list', () => {
    expect(() => createLiveEnginePolicy({ stages: [] })).toThrow(expect.objectContaining({ code: 'LIVE_POLICY_INVALID' }));
  });
});
