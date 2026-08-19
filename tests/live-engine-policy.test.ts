import { describe, expect, it } from 'vitest';
import {
  PROBE_BASELINE_MS,
  PROBE_MAX_SCALE,
  completeLiveEngineAttempt,
  createLiveEnginePolicy,
  reserveLiveEngineAttempt,
  timeoutScaleForLatency,
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

  /*
   * The per-stage timeout is a bet on how fast the provider is, and a fixed bet lost on a real one.
   * `major`'s check stage runs 49 turns; on the gateway this project is configured with — measured
   * at ~13s for a trivial round trip and ~7s per turn — its API time alone is 5.8 minutes, so the
   * shipped 900s could not absorb a slow turn. It was killed twice at exactly 900s having produced
   * nothing, then passed every stage first-attempt at 2700s. Deriving the ceiling from a measurement
   * is what removes the hand-tuning that discovery otherwise costs.
   */
  describe('per-stage timeout scaling', () => {
    it('leaves the shipped ceiling alone on a fast provider', () => {
      expect(timeoutScaleForLatency(400)).toBe(1);
      expect(timeoutScaleForLatency(PROBE_BASELINE_MS)).toBe(1);
    });

    it('lengthens the ceiling for the slow provider that exposed this', () => {
      /* The latency actually measured against api.deepseek.com/anthropic during the 2026-08-18 runs. */
      expect(timeoutScaleForLatency(13_333)).toBe(PROBE_MAX_SCALE);
      /* 900s * 4 = 3600s, comfortably above the 2700s that let every major stage pass first try. */
      expect(900 * timeoutScaleForLatency(13_333)).toBeGreaterThan(2700);
    });

    it('never shortens a deadline, whatever the probe says', () => {
      /* The default encodes more than latency, so a fast endpoint does not earn a tighter ceiling. */
      for (const latency of [1, 10, 100, 999]) expect(timeoutScaleForLatency(latency)).toBe(1);
    });

    it('caps the scale rather than waiting out an unusable provider', () => {
      expect(timeoutScaleForLatency(10 * 60 * 1000)).toBe(PROBE_MAX_SCALE);
    });

    it('keeps the default when the probe could not be made', () => {
      /* null is "unmeasured", which must not be guessed in either direction. */
      for (const value of [null, Number.NaN, 0, -5]) expect(timeoutScaleForLatency(value)).toBe(1);
    });
  });
});
