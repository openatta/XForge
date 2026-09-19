// design: cli §4 — claude 的载荷与回答格式：PreToolUse 的 tool_name/tool_input，回 hookSpecificOutput。
import type { ToolAction } from '../../model/types.js';
import type { Call, Decision, PayloadAdapter } from './index.js';

const WRITE_TOOLS: Record<string, ToolAction> = { Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit' };
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch']);

export const claudePayload: PayloadAdapter = {
  id: 'claude',

  parse(raw: string, fallbackCwd: string): Call {
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
  },

  /**
   * 放行**什么都不说**：`permissionDecision: allow` 会跳过 claude 自己的审批提示
   * （人写死的 deny / ask 规则照样生效，但「默认会问一句」的那些就不问了）。
   * 一个治理钩子的本分是拦与升级，不是放行 —— 空 stdout = 没有意见，这次调用照常走宿主的权限流程。
   */
  render(d: Decision): string | null {
    if (d.decision === 'allow') return null;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } });
  },
};
