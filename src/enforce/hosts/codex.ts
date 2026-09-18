// design: cli §4 — codex 的 PreToolUse 协议：`Bash` 与 `apply_patch` 都往 `tool_input.command` 放载荷；
// 写入目标要从补丁正文里读出来，读不出就是解析失败（失败的裁决在调用方，一律朝安全）。
import type { Call, Decision, HostProtocol } from './protocol.js';

const ADD = /^\*\*\* Add File: (.+)$/;
const UPDATE = /^\*\*\* Update File: (.+)$/;
const DELETE = /^\*\*\* Delete File: (.+)$/;
const MOVE = /^\*\*\* Move to: (.+)$/;

/** 补丁里点到的每个路径：增、改、删各点一个，改名点「从哪」与「到哪」两处。 */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    const m = ADD.exec(line) ?? UPDATE.exec(line) ?? DELETE.exec(line) ?? MOVE.exec(line);
    if (!m) continue;
    const p = m[1]!.trim();
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

export function parseCodex(raw: string, fallbackCwd: string): Call {
  const payload = JSON.parse(raw) as { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : fallbackCwd;
  const tool = payload.tool_name ?? '';
  const input = payload.tool_input ?? {};
  const body = String(input['command'] ?? '');
  if (tool === 'Bash') return { action: 'shell', paths: [], command: body, cwd };
  if (tool === 'apply_patch') {
    const paths = patchPaths(body);
    // 一次看不见目标的写入不许悄悄过去：补丁读不出目标就当作解析失败。
    if (!paths.length) throw new Error('apply_patch 的补丁里找不到写入目标');
    return { action: 'edit', paths, cwd };
  }
  return { action: 'other', paths: [], cwd };
}

/**
 * codex 没有「问」：`permissionDecision: ask` 会被它记成钩子失败，然后**继续执行**这次调用 —— 等于静默放行。
 * 所以 ask 在这里降级成 deny，理由里写明要人点头。理由不能为空，空的 deny 同样被记成钩子失败。
 */
function renderCodex(d: Decision): string | null {
  if (d.decision === 'allow') return null; // 什么都不说 = 这次调用照常走它自己的审批与沙箱
  const ask = d.decision === 'ask';
  const reason = `${d.reason || (ask ? '策略要求先问人' : '策略拒绝，没给理由')}${ask ? ' —— 这一步要人点头（此处没有「问」这个选项，按拒绝处理）' : ''}`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

export const codexProtocol: HostProtocol = { parse: parseCodex, render: renderCodex };
