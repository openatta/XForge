// design: cli §4 — 执法侧的载荷适配：每个宿主一份解析与渲染，按 --host 选。
import { describe, expect, it } from 'vitest';
import { FALLBACK_PAYLOAD, payloadFor } from '../../../src/enforce/payloads/index.js';

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

  it('renders the hook answer claude understands, and says nothing to allow (CLI-45)', () => {
    expect(JSON.parse(claude.render({ decision: 'deny', reason: 'x' })!)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' },
    });
    expect(JSON.parse(claude.render({ decision: 'ask', reason: 'y' })!)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'y' },
    });
    // 显式 allow 会跳过 claude 自己的审批提示：治理钩子只否决或升级。
    expect(claude.render({ decision: 'allow', reason: '' })).toBeNull();
  });
});

describe('the registry', () => {
  it('has no adapter for a host it does not know, and falls back to a shape hosts can read (CLI-39)', () => {
    expect(payloadFor('zed')).toBeUndefined();
    expect(FALLBACK_PAYLOAD).toBe(claude);
  });
});

describe('codex payload（CLI-57）', () => {
  const codex = payloadFor('codex')!;
  const call = (command: string, cwd = '/p'): ReturnType<typeof codex.parse> =>
    codex.parse(JSON.stringify({ cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), '/fallback');

  it('apply_patch 是一条 Bash 命令：写入目标从补丁正文里取', () => {
    // 2026-09-19 在 codex 0.155.1 上抓到的真实形状。
    const heredoc = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: c.txt\n+CCC\n*** End Patch\nPATCH";
    expect(call(heredoc)).toEqual({ action: 'edit', paths: ['c.txt'], cwd: '/p' });
    const quoted = 'apply_patch "*** Begin Patch\n*** Update File: src/a.py\n*** Move to: src/b.py\n*** End Patch"';
    expect(call(quoted).paths).toEqual(['src/a.py', 'src/b.py']);
  });

  it('普通命令走 shell；一个目标都取不到的补丁按解析失败', () => {
    expect(call('pwd && ls -la')).toEqual({ action: 'shell', paths: [], command: 'pwd && ls -la', cwd: '/p' });
    // 一次看不见目标的写入不许悄悄过去。
    expect(() => call('*** Begin Patch\n+garbage\n*** End Patch')).toThrow();
  });

  it('没有 command 的载荷归 other：执法的边界就是那四类', () => {
    expect(codex.parse(JSON.stringify({ cwd: '/p', tool_name: 'view_image', tool_input: {} }), '/f').action).toBe('other');
    expect(codex.parse(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), '/fallback').cwd).toBe('/fallback');
  });

  it('引擎只收 deny：放行静默，ask 降级，理由不许为空', () => {
    // codex 0.155.1 的引擎错误串：unsupported permissionDecision:allow / :ask；
    // deny without a non-empty permissionDecisionReason。
    expect(codex.render({ decision: 'allow', reason: '' })).toBeNull();
    const ask = JSON.parse(codex.render({ decision: 'ask', reason: '这一步要人批' })!) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(ask.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(ask.hookSpecificOutput.permissionDecisionReason).toContain('要人点头');
    const bare = JSON.parse(codex.render({ decision: 'deny', reason: '' })!) as { hookSpecificOutput: { permissionDecisionReason: string } };
    expect(bare.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
  });
});
