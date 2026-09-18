// design: cli §4 — claude 的 PreToolUse 协议：载荷字段 `tool_name` / `tool_input`，裁决回 `hookSpecificOutput`。
import type { ToolAction } from '../../model/types.js';
import type { Call, Decision, HostProtocol } from './protocol.js';

const WRITE_TOOLS: Record<string, ToolAction> = { Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit' };
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch']);

export function parseClaude(raw: string, fallbackCwd: string): Call {
  const payload = JSON.parse(raw) as { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : fallbackCwd;
  const tool = payload.tool_name ?? '';
  const input = payload.tool_input ?? {};
  if (tool === 'Bash') return { action: 'shell', paths: [], command: String(input['command'] ?? ''), cwd };
  const write = WRITE_TOOLS[tool];
  if (write) {
    const p = String(input['file_path'] ?? input['notebook_path'] ?? '');
    return { action: write, paths: p ? [p] : [], cwd };
  }
  if (READ_TOOLS.has(tool)) return { action: 'read', paths: [], cwd };
  return { action: 'other', paths: [], cwd };
}

/**
 * 放行**什么都不说**：claude 的 `permissionDecision: allow` 会跳过它自己的审批提示
 * （deny / ask 规则照样生效，但「默认会问一句」的那些就不问了）—— 一个钩子的本分是拦与升级，不是放行。
 * 空 stdout = 没有意见，这次调用照常走 claude 的权限流程（cli §4）。
 */
function renderClaude(d: Decision): string | null {
  if (d.decision === 'allow') return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } });
}

export const claudeProtocol: HostProtocol = { parse: parseClaude, render: renderClaude };
