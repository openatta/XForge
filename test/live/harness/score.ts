// design: live-test §4 — 计分与观测；D6：只有 tokens，没有货币。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnResult, Usage } from './engine.js';

export interface Observations {
  show_calls: number;
  direct_change_reads: number;
  design_full_reads: number;
  enforce_denies: number;
  inspect_calls: number;
  xforge_calls: number;
  tool_uses: number;
  /** 读治理目录（xforge/scaffold、schema）与 xforge 自己的包目录的次数：执行者提示词说了不要，这里只报不判。 */
  governance_reads: number;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** 扫 stream 与会话转录里的 tool_use / tool_result 块，主会话与子 Agent 都算。 */
export function observe(files: string[]): Observations {
  const o: Observations = { show_calls: 0, direct_change_reads: 0, design_full_reads: 0, enforce_denies: 0, inspect_calls: 0, xforge_calls: 0, tool_uses: 0, governance_reads: 0 };
  const seen = new Set<string>();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const message = (msg['message'] as Record<string, unknown> | undefined) ?? msg;
      const content = message['content'];
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'tool_use') {
          const id = String(block['id'] ?? '');
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          o.tool_uses += 1;
          const input = (block['input'] as Record<string, unknown> | undefined) ?? {};
          const name = String(block['name'] ?? '');
          if (name === 'Bash') {
            const cmd = String(input['command'] ?? '');
            if (/\bxforge\b/.test(cmd)) o.xforge_calls += 1;
            if (/\bxforge\s+show\b/.test(cmd)) o.show_calls += 1;
            if (/\bxforge\s+inspect\b/.test(cmd)) o.inspect_calls += 1;
            if (/\b(cat|sed|head|tail|less)\b[^|;&]*xforge\/changes\//.test(cmd)) o.direct_change_reads += 1;
            if (/\b(cat|sed|head|tail|less|grep|rg|ls|find)\b[^|;&]*(xforge\/scaffold|schemas\/|node_modules\/@xforge|\/pkg\/)/.test(cmd)) o.governance_reads += 1;
          }
          if (name === 'Read') {
            const path = String(input['file_path'] ?? '');
            if (path.includes('/xforge/changes/')) o.direct_change_reads += 1;
            if (/xforge\/scaffold|schemas\/|node_modules\/@xforge|\/pkg\//.test(path)) o.governance_reads += 1;
            if (path.endsWith('/design.md') && input['offset'] === undefined && input['limit'] === undefined) o.design_full_reads += 1;
          }
        }
        if (block['type'] === 'tool_result' && block['is_error'] === true) {
          // 钩子的拒绝以诊断码开头且 is_error；工具输出里顺带出现这个字符串（explain、grep 源码）不算。
          const text = typeof block['content'] === 'string' ? block['content'] : '';
          if (/^XF-ENFORCE-00\d/.test(text.trim())) o.enforce_denies += 1;
        }
      }
    }
  }
  return o;
}

export function sumUsage(turns: readonly TurnResult[]): Usage {
  return turns.reduce((acc, t) => ({ input: acc.input + t.usage.input, output: acc.output + t.usage.output, cache_read: acc.cache_read + t.usage.cache_read, cache_creation: acc.cache_creation + t.usage.cache_creation }), { input: 0, output: 0, cache_read: 0, cache_creation: 0 });
}

export function transcriptFiles(transcriptsDir: string, sessionsDir: string): string[] {
  return [...walk(transcriptsDir), ...walk(sessionsDir)];
}

export interface Summary {
  engine: string;
  scenario: string;
  language: string;
  governance: 'TT' | 'TF' | 'FT' | 'FF';
  driver: 'orchestrated' | 'stepwise';
  /** 审批由谁给（D14）；mcp 时 mcp_approvals 是链上带 via 的审批事件数。 */
  approver: 'human' | 'mcp';
  mcp_approvals: number;
  /** stepwise 才有：多少轮的结果文本里报了下一步的 `/xforge-<站>`（SK-13）。 */
  next_skill_hints: { turns: number; hinted: number } | null;
  /** LT-07：Change 的规格 delta 里每条 Requirement 是否被模型自写的测试或保证说明的覆盖表引用；规格治理关着时为 null。 */
  requirement_coverage: { total: number; covered: number; missing: string[] } | null;
  baseline_changed: { spec: boolean; interface: boolean };
  model: string | undefined;
  outcome: string;
  stopped_at: string | null;
  turns: number;
  reworks: number;
  oracle: { ran: number; failed: number };
  inspect_exit: number;
  tamper: { exit: number; codes: string[] } | null;
  tokens: Usage & { per_turn: Array<Usage & { turn: number; duration_ms: number; num_turns: number }> };
  observations: Observations;
  human_actions: Array<{ turn: number; action: string; ok: boolean; detail?: string | undefined }>;
  blocked_tokens: string[];
  run_dir: string;
}

export function renderSummary(s: Summary): string {
  const t = s.tokens;
  const lines = [
    `# live · ${s.engine} · ${s.scenario} · ${s.language} · 治理 ${s.governance}`,
    '',
    `| 项 | 值 |`,
    `| --- | --- |`,
    `| 模型 | ${s.model ?? '?'} |`,
    `| 审批 | ${s.approver}${s.approver === 'mcp' ? `（MCP 批了 ${s.mcp_approvals} 次）` : ''} |`,
    `| 驱动 | ${s.driver}${s.next_skill_hints ? `（报了下一步 Skill 的轮数 ${s.next_skill_hints.hinted} / ${s.next_skill_hints.turns}）` : ''} |`,
    `| Requirement 覆盖 | ${s.requirement_coverage ? `${s.requirement_coverage.covered} / ${s.requirement_coverage.total}${s.requirement_coverage.missing.length ? `，缺 ${s.requirement_coverage.missing.join('、')}` : ''}` : '不适用（规格治理关）'} |`,
    `| 结果 | ${s.outcome}${s.stopped_at ? `（停在 ${s.stopped_at}）` : ''} |`,
    `| 轮数 | ${s.turns} |`,
    `| 返工 | ${s.reworks} |`,
    `| oracle | ${s.oracle.ran - s.oracle.failed} / ${s.oracle.ran} |`,
    `| inspect 退出码 | ${s.inspect_exit} |`,
    `| 篡改检测 | ${s.tamper ? `退出码 ${s.tamper.exit}，${s.tamper.codes.join('、') || '无码'}` : '未跑'} |`,
    `| 基线是否变动 | 规格 ${s.baseline_changed.spec ? '变' : '不变'} · 接口 ${s.baseline_changed.interface ? '变' : '不变'} |`,
    `| tokens · input | ${t.input} |`,
    `| tokens · output | ${t.output} |`,
    `| tokens · cache_read | ${t.cache_read} |`,
    `| tokens · cache_creation | ${t.cache_creation} |`,
    '',
    '## 每轮 tokens',
    '',
    '| 轮 | input | output | cache_read | cache_creation | 内部轮次 | 用时 s |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...t.per_turn.map((p) => `| ${p.turn} | ${p.input} | ${p.output} | ${p.cache_read} | ${p.cache_creation} | ${p.num_turns} | ${(p.duration_ms / 1000).toFixed(0)} |`),
    '',
    '## 观测',
    '',
    `| 项 | 值 |`,
    `| --- | --- |`,
    `| xforge 调用 | ${s.observations.xforge_calls} |`,
    `| xforge show 调用 | ${s.observations.show_calls} |`,
    `| 直接读 xforge/changes/** | ${s.observations.direct_change_reads} |`,
    `| design.md 整读 | ${s.observations.design_full_reads} |`,
    `| 执法 deny | ${s.observations.enforce_denies} |`,
    `| inspect 调用 | ${s.observations.inspect_calls} |`,
    `| 工具调用总数 | ${s.observations.tool_uses} |`,
    `| 读治理目录 / 包目录 | ${s.observations.governance_reads} |`,
    '',
    '## harness 扮演的人',
    '',
    ...s.human_actions.map((a) => `- 轮 ${a.turn}：${a.action} → ${a.ok ? 'ok' : 'FAIL'}${a.detail ? ` ${a.detail}` : ''}`),
    '',
    s.blocked_tokens.length ? `阻塞 token：${s.blocked_tokens.join('、')}` : '',
    '',
    `运行目录：${s.run_dir}`,
    '',
  ];
  return lines.join('\n');
}
