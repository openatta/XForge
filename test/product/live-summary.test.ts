// design: live-test §4 — LT-05：summary 里只有 tokens，没有货币。
import { describe, expect, it } from 'vitest';
import { renderSummary, type Summary } from '../live/harness/score.js';

describe('live summary', () => {
  it('LT-05 renders tokens and never money', () => {
    const s: Summary = {
      engine: 'claude', scenario: 'quick', language: 'zh-CN', governance: 'TT', driver: 'orchestrated', approver: 'human', mcp_approvals: 0, next_skill_hints: null, requirement_coverage: null, baseline_changed: { spec: true, interface: true }, model: 'm',
      outcome: 'archived', stopped_at: null, turns: 2, reworks: 0, oracle: { ran: 3, failed: 0 }, inspect_exit: 0, tamper: { exit: 3, codes: ['XF-INSPECT-001'] },
      tokens: { input: 10, output: 20, cache_read: 30, cache_creation: 40, per_turn: [{ turn: 1, input: 5, output: 10, cache_read: 15, cache_creation: 20, duration_ms: 1000, num_turns: 3 }] },
      observations: { show_calls: 1, direct_change_reads: 0, design_full_reads: 0, enforce_denies: 0, inspect_calls: 0, xforge_calls: 4, tool_uses: 6, governance_reads: 0 },
      human_actions: [], blocked_tokens: [], run_dir: '/tmp/x',
    };
    const md = renderSummary(s);
    expect(md).toContain('tokens · output | 20');
    expect(/\$|USD|费用|cost|price/i.test(md)).toBe(false);
  });
});
