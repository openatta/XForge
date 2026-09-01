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
    const policy = createLiveEnginePolicy({ stages: ['design', 'apply'], suiteBudgetUsd: 5, maxAttemptsPerStage: 2, timeoutSeconds: 60 });
    const first = reserveLiveEngineAttempt(policy, {
      stage: 'design', requestedBudgetUsd: 3, isolation: 'external-launcher', startedAt: '2026-08-09T00:00:00.000Z',
    });
    completeLiveEngineAttempt(policy, {
      stage: 'design', attempt: first.attempt, costUsd: 2.75, exitCode: 0, timedOut: false,
      classification: 'success', output: 'design.json', finishedAt: '2026-08-09T00:01:00.000Z',
    });
    const second = reserveLiveEngineAttempt(policy, {
      stage: 'apply', requestedBudgetUsd: 3, isolation: 'external-launcher', startedAt: '2026-08-09T00:02:00.000Z',
    });
    expect(second.effectiveBudgetUsd).toBe(2.25);
  });

  it('enforces the per-stage retry limit', () => {
    const policy = createLiveEnginePolicy({ stages: ['verify'], suiteBudgetUsd: 9, maxAttemptsPerStage: 1, timeoutSeconds: 60 });
    const reserved = reserveLiveEngineAttempt(policy, {
      stage: 'verify', requestedBudgetUsd: 3, isolation: 'behavioral', startedAt: '2026-08-09T00:00:00.000Z',
    });
    completeLiveEngineAttempt(policy, {
      stage: 'verify', attempt: reserved.attempt, costUsd: 1, exitCode: 1, timedOut: false,
      classification: 'model_behavior_failure', output: 'verify.json', finishedAt: '2026-08-09T00:01:00.000Z',
    });
    expect(() => reserveLiveEngineAttempt(policy, {
      stage: 'verify', requestedBudgetUsd: 3, isolation: 'behavioral', startedAt: '2026-08-09T00:02:00.000Z',
    })).toThrow(expect.objectContaining({ code: 'LIVE_RETRY_LIMIT' }));
  });

  it('fails closed when a call completes and reports no cost', () => {
    /*
     * The unaccountable case: the provider answered, and cannot say what it charged. There is no
     * ceiling to reason from, so continuing would be spending against a number nobody has.
     */
    const policy = createLiveEnginePolicy({ stages: ['apply', 'verify'] });
    const reserved = reserveLiveEngineAttempt(policy, {
      stage: 'apply', requestedBudgetUsd: 3, isolation: 'behavioral', startedAt: '2026-08-09T00:00:00.000Z',
    });
    completeLiveEngineAttempt(policy, {
      stage: 'apply', attempt: reserved.attempt, costUsd: null, exitCode: 1, timedOut: false,
      classification: 'model_behavior_failure', output: 'apply.json', finishedAt: '2026-08-09T00:01:00.000Z',
    });
    expect(policy.budgetAccountingComplete).toBe(false);
    expect(() => reserveLiveEngineAttempt(policy, {
      stage: 'verify', requestedBudgetUsd: 3, isolation: 'behavioral', startedAt: '2026-08-09T00:02:00.000Z',
    })).toThrow(expect.objectContaining({ code: 'LIVE_BUDGET_UNKNOWN' }));
  });

  it('charges a timed-out attempt its reserved budget, so the retry it is entitled to can run', () => {
    /*
     * A killed call reports no usage — that is every timeout there is — so treating "no cost" as
     * unaccountable made `maxAttemptsPerStage` unreachable for the one classification the RUNBOOK
     * says is re-runnable. A live `solid-contract` run died exactly here: design timed out at the
     * ceiling, attempt 2 was refused by the budget guard, and the scenario ended having concluded
     * nothing.
     *
     * The ceiling is the bound: the call ran until its own deadline, so it cannot have cost more than
     * the budget reserved for it. Over-stating is the safe direction, and the suite budget still stops
     * the run.
     */
    const policy = createLiveEnginePolicy({ stages: ['design', 'verify'], suiteBudgetUsd: 9, maxAttemptsPerStage: 2, timeoutSeconds: 900 });
    const reserved = reserveLiveEngineAttempt(policy, {
      stage: 'design', requestedBudgetUsd: 3, isolation: 'behavioral', startedAt: '2026-08-09T00:00:00.000Z',
    });
    const settled = completeLiveEngineAttempt(policy, {
      stage: 'design', attempt: reserved.attempt, costUsd: null, tokens: null, exitCode: 143, timedOut: true,
      classification: 'environment_blocked', output: 'design.json', finishedAt: '2026-08-09T00:15:00.000Z',
    });
    expect(settled.budgetAccountingComplete).toBe(true);
    expect(settled.spentUsd).toBe(3);
    const run = policy.stages.design.runs.at(-1);
    expect(run.costUsd).toBe(3);
    /* Recorded as a ceiling, never presented as a measurement. */
    expect(run.costEstimated).toBe(true);

    const retry = reserveLiveEngineAttempt(policy, {
      stage: 'design', requestedBudgetUsd: 3, isolation: 'behavioral', startedAt: '2026-08-09T00:16:00.000Z',
    });
    expect(retry.attempt).toBe(2);
  });

  it('takes whatever stage list the Flow graph actually has', () => {
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
    /* And omitting it entirely, which used to hand back a Stage list no current Flow has. */
    expect(() => createLiveEnginePolicy()).toThrow(expect.objectContaining({ code: 'LIVE_POLICY_INVALID' }));
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
