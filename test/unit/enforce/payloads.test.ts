// design: cli §4 — 执法侧的载荷适配：每个宿主一份解析与渲染，按 --host 选。
import { describe, expect, it } from 'vitest';
import { payloadFor } from '../../../src/enforce/payloads/index.js';

const claude = payloadFor('claude')!;
const parse = (payload: unknown): ReturnType<typeof claude.parse> => claude.parse(JSON.stringify(payload), '/fallback');

describe('claude payload', () => {
  it('maps tools onto actions, paths and commands', () => {
    expect(parse({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/p' })).toEqual({ action: 'shell', paths: [], command: 'ls', cwd: '/p' });
    expect(parse({ tool_name: 'Write', tool_input: { file_path: '/p/a.ts' }, cwd: '/p' })).toEqual({ action: 'write', paths: ['/p/a.ts'], cwd: '/p' });
    expect(parse({ tool_name: 'MultiEdit', tool_input: { file_path: '/p/a.ts' }, cwd: '/p' }).action).toBe('edit');
    expect(parse({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/p/a.ipynb' }, cwd: '/p' }).paths).toEqual(['/p/a.ipynb']);
    expect(parse({ tool_name: 'Grep', tool_input: {}, cwd: '/p' }).action).toBe('read');
    expect(parse({ tool_name: 'Task', tool_input: {}, cwd: '/p' }).action).toBe('other');
  });

  it('falls back to the given cwd and throws on a payload that is not JSON', () => {
    expect(parse({ tool_name: 'Read' }).cwd).toBe('/fallback');
    expect(() => claude.parse('not json', '/fallback')).toThrow();
  });

  it('renders the hook answer claude understands', () => {
    expect(JSON.parse(claude.render({ decision: 'deny', reason: 'x' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' },
    });
  });
});

describe('the registry', () => {
  it('has no adapter for a host it does not know', () => {
    expect(payloadFor('codex')).toBeUndefined();
    expect(payloadFor('zed')).toBeUndefined();
  });
});
