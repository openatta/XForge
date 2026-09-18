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

  render(d: Decision): string {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } });
  },
};
