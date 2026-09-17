// design: live-test §5 D12 — XF_LIVE_ENGINE / XF_LIVE_SCENARIO / XF_LIVE_LANGUAGE / XF_LIVE_GOVERNANCE / XF_LIVE_DRIVER；不设场景则按顺序全跑。
import { describe, expect, it } from 'vitest';
import { meetsExpectation, runScenario, SCENARIOS, type Driver, type Scenario } from './harness/run.js';
import type { Engine } from './harness/env.js';
import type { Governance } from './harness/setup.js';

const engine = (process.env['XF_LIVE_ENGINE'] ?? 'claude') as Engine;
const language = (process.env['XF_LIVE_LANGUAGE'] ?? 'zh-CN') as 'zh-CN' | 'en';
const requested = process.env['XF_LIVE_SCENARIO'];
const governance = (process.env['XF_LIVE_GOVERNANCE'] ?? 'TT') as Governance;
const driver = (process.env['XF_LIVE_DRIVER'] ?? 'orchestrated') as Driver;
const approver = (process.env['XF_LIVE_APPROVER'] ?? 'human') as 'human' | 'mcp';
const scenarios: Scenario[] = requested ? (requested.split(',') as Scenario[]) : ['quick', 'solid', 'solid-rework', 'major'];

describe(`live · ${engine} · ${language} · ${governance} · ${driver} · ${approver}`, () => {
  for (const scenario of scenarios) {
    if (!SCENARIOS[scenario]) throw new Error(`未知场景 ${scenario}`);
    it(scenario, async () => {
      const summary = await runScenario({ engine, scenario, language, governance, driver, approver });
      // eslint-disable-next-line no-console
      console.log(`\n[live] ${engine} ${scenario} ${governance} ${driver}: ${summary.outcome}, ${summary.turns} 轮, 返工 ${summary.reworks}, oracle ${summary.oracle.ran - summary.oracle.failed}/${summary.oracle.ran}, tokens in ${summary.tokens.input} out ${summary.tokens.output} cache_read ${summary.tokens.cache_read}\n  ${summary.run_dir}/summary.md`);
      expect(meetsExpectation(summary, scenario), JSON.stringify(summary, null, 2)).toEqual([]);
    });
  }
});
