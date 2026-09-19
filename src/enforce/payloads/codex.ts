// design: cli §4 — codex 的载荷与回答格式。形状与 claude 相同（`tool_name` / `tool_input` / `cwd`），
// 但它的引擎只收 deny，且 deny 的理由不能为空。
import type { Call, Decision, PayloadAdapter } from './index.js';

/**
 * 补丁正文里点到的路径：增、改、删各点一个，改名点「从哪」与「到哪」两处。
 * codex 的 `apply_patch` 是**当成一条 Bash 命令**发过来的（2026-09-19 在 codex 0.155.1 上实测），
 * 正文可能是 heredoc 也可能是引号里的一个参数，所以按行扫而不是按 shell 语法解析。
 */
export function patchPaths(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split('\n')) {
    const line = raw.trim();
    const m = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/.exec(line) ?? /^\*\*\*\s+Move\s+to:\s+(.+)$/.exec(line);
    if (!m) continue;
    const p = m[1]!.trim().replace(/^["']|["']$/g, '');
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

/** 这条命令是不是一次 apply_patch（正文里有补丁标记）。 */
const isPatch = (command: string): boolean => /^\s*\*\*\*\s+Begin Patch\s*$/m.test(command) || patchPaths(command).length > 0;

export const codexPayload: PayloadAdapter = {
  id: 'codex',

  /**
   * codex 0.155.1 实测：一切都以 `tool_name: "Bash"` + `tool_input.command` 过来，
   * 包括 `apply_patch`。认不出的工具归 `other` —— 策略只能选 read/write/edit/shell 四类，
   * `other` 谁也选不中，执法的边界就是这四类（§4 第 1 步）。
   */
  parse(raw: string, fallbackCwd: string): Call {
    const payload = JSON.parse(raw) as { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : fallbackCwd;
    const input = payload.tool_input ?? {};
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    if (!command) return { action: 'other', paths: [], cwd };
    if (!isPatch(command)) return { action: 'shell', paths: [], command, cwd };
    const paths = patchPaths(command);
    // 一次看不见目标的写入不许悄悄过去：有 Begin Patch 却一个目标都读不出来，按解析失败处理。
    if (!paths.length) throw new Error('apply_patch 的补丁里找不到写入目标');
    return { action: 'edit', paths, cwd };
  },

  /**
   * codex 的引擎（0.155.1）对 PreToolUse 只接受 `deny`，而且理由不能为空 —— 二进制里的错误串：
   *   `PreToolUse hook returned unsupported permissionDecision:allow`
   *   `PreToolUse hook returned unsupported permissionDecision:ask`
   *   `PreToolUse hook returned permissionDecision:deny without a non-empty permissionDecisionReason`
   * 所以放行什么都不说（与 claude 同，§4 第 6 步），`ask` 降级成 `deny` 并写明要人点头 ——
   * 在没有「问」这一步的宿主上回 `ask`，会被记成钩子失败然后**继续执行**，等于静默放行。
   */
  render(d: Decision): string | null {
    if (d.decision === 'allow') return null;
    const ask = d.decision === 'ask';
    const base = d.reason || (ask ? '策略要求先问人' : '策略拒绝');
    const reason = ask ? `${base} —— 这一步要人点头，而这个宿主没有「问」这个选项，按拒绝处理` : base;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  },
};
