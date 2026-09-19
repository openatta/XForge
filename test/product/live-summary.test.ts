// design: live-test §4 — LT-05：summary 里只有 tokens，没有货币。
import { describe, expect, it } from 'vitest';
import { assemblyProblems, readAssembly } from '../live/harness/assembly.js';
import { renderSummary, type Summary } from '../live/harness/score.js';
import type { Envelope } from '../../src/model/types.js';

describe('live summary', () => {
  it('LT-05 renders tokens and never money', () => {
    const s: Summary = {
      engine: 'claude', scenario: 'quick', language: 'zh-CN', governance: 'TT', driver: 'orchestrated', approver: 'human', mcp_approvals: 0, next_skill_hints: null, requirement_coverage: null, baseline_changed: { spec: true, interface: true }, model: 'm',
      outcome: 'archived', stopped_at: null, turns: 2, reworks: 0, oracle: { ran: 3, failed: 0 }, inspect_exit: 0, assembly: null, tamper: { exit: 3, codes: ['XF-INSPECT-001'] },
      tokens: { input: 10, output: 20, cache_read: 30, cache_creation: 40, per_turn: [{ turn: 1, input: 5, output: 10, cache_read: 15, cache_creation: 20, duration_ms: 1000, num_turns: 3 }] },
      observations: { show_calls: 1, direct_change_reads: 0, design_full_reads: 0, enforce_denies: 0, inspect_calls: 0, xforge_calls: 4, tool_uses: 6, governance_reads: 0 },
      human_actions: [], blocked_tokens: [], run_dir: '/tmp/x',
    };
    const md = renderSummary(s);
    expect(md).toContain('tokens · output | 20');
    expect(/\$|USD|费用|cost|price/i.test(md)).toBe(false);
  });
});

describe('装配面的真机结论（LT-09 LT-10 LT-11）', () => {
  const clean: Envelope = { ok: true, verb: 'doctor', result: {}, diagnostics: [], changed: [], next: [] };
  const diag = (code: string, severity: 'blocking' | 'warning' | 'info'): Envelope['diagnostics'][number] => ({ code, severity, message: code });

  it('干净的树、doctor 不写盘、repair 把注入的漂移收敛：没有问题可报', () => {
    const doctor: Envelope = { ...clean, diagnostics: [diag('XF-ASSEMBLE-009', 'info')] };
    const repaired: Envelope = { ...clean, verb: 'repair', changed: ['.claude/skills/xforge/SKILL.md'] };
    const a = readAssembly(doctor, 0, { env: repaired, exit: 0 }, clean);
    expect(a.codes).toEqual([]); // info 不算问题
    expect(assemblyProblems(a)).toEqual([]);
  });

  it('每一种不对都说出是哪里不对', () => {
    const dirty: Envelope = { ...clean, ok: false, diagnostics: [diag('XF-ASSEMBLE-006', 'blocking')], changed: ['x'] };
    const problems = assemblyProblems(readAssembly(dirty, 1, { env: { ...clean, changed: [] }, exit: 1 }, dirty));
    expect(problems.join(' | ')).toContain('doctor 报了 XF-ASSEMBLE-006');
    expect(problems.join(' | ')).toContain('doctor 写了盘');
    expect(problems.join(' | ')).toContain('repair 没有改动任何文件');
    expect(problems.join(' | ')).toContain('repair 之后仍有 XF-ASSEMBLE-006');
    expect(problems.join(' | ')).toContain('repair 退出码 1');
  });
});
