// design: cli §5.1 — CLI-44 的组件那一半：按键 → 状态 → 画面是纯函数，灰显不可选，必选未满足不放行。
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { ask, decodeKey, initialState, onKey, renderQuestion, type Question } from '../../../src/cli/prompt.js';

const ESC = String.fromCharCode(27);

const tools: Question = {
  key: 'platform',
  prompt: 'Which AI coding tools should XForge project into?',
  multi: true,
  choices: [
    { value: 'claude', label: 'Claude Code', note: 'detected 2.1.0' },
    { value: 'codex', label: 'Codex CLI', note: 'not detected', disabled: true },
    { value: 'zed', label: 'Zed', note: 'detected' },
  ],
};

const language: Question = {
  key: 'language',
  prompt: 'Which language should the projected Skills use?',
  multi: false,
  choices: [
    { value: 'zh-CN', label: 'Chinese (zh-CN)' },
    { value: 'en', label: 'English' },
  ],
};

describe('keys', () => {
  it('maps the sequences a terminal actually sends', () => {
    expect(decodeKey(`${ESC}[A`)).toBe('up');
    expect(decodeKey(`${ESC}[B`)).toBe('down');
    expect(decodeKey('k')).toBe('up');
    expect(decodeKey(' ')).toBe('space');
    expect(decodeKey('\r')).toBe('enter');
    expect(decodeKey(String.fromCharCode(3))).toBe('abort');
    expect(decodeKey(ESC)).toBe('abort');
    expect(decodeKey('x')).toBe('other');
  });
});

describe('selection', () => {
  it('starts empty when multi, preselects the first selectable when single', () => {
    expect(initialState(tools)).toEqual({ cursor: 0, selected: [] });
    expect(initialState(language)).toEqual({ cursor: 0, selected: ['zh-CN'] });
  });

  it('the cursor steps over disabled choices, both ways, wrapping', () => {
    const down = onKey(tools, initialState(tools), 'down');
    expect(down.state.cursor).toBe(2); // 跳过灰显的 codex
    expect(onKey(tools, down.state, 'down').state.cursor).toBe(0); // 绕回
    expect(onKey(tools, initialState(tools), 'up').state.cursor).toBe(2);
  });

  it('space toggles a selectable choice and refuses a greyed one, saying why', () => {
    const one = onKey(tools, initialState(tools), 'space');
    expect(one.state.selected).toEqual(['claude']);
    expect(onKey(tools, one.state, 'space').state.selected).toEqual([]);
    const onDisabled = onKey(tools, { cursor: 1, selected: [] }, 'space');
    expect(onDisabled.state.selected).toEqual([]);
    expect(onDisabled.state.error).toContain('not detected');
    expect(onDisabled.state.error).toContain('command line');
  });

  it('single select replaces instead of accumulating', () => {
    const en = onKey(language, { cursor: 1, selected: ['zh-CN'] }, 'space');
    expect(en.state.selected).toEqual(['en']);
  });

  it('enter with nothing chosen does not pass', () => {
    const empty = onKey(tools, initialState(tools), 'enter');
    expect(empty.done).toBe(false);
    expect(empty.state.error).toBe('Select at least one with space.');
    const chosen = onKey(tools, { cursor: 0, selected: ['claude'] }, 'enter');
    expect(chosen.done).toBe(true);
  });
});

describe('the picture', () => {
  it('shows the box, the cursor and every note, in English', () => {
    const lines = renderQuestion(tools, { cursor: 0, selected: ['claude'] }, false);
    expect(lines[0]).toBe('? Which AI coding tools should XForge project into? (space to select, enter to confirm)');
    expect(lines[1]).toBe('> [x] Claude Code  detected 2.1.0');
    expect(lines[2]).toBe('  [ ] Codex CLI  not detected');
    expect(lines[3]).toBe('  [ ] Zed  detected');
    expect(lines.join('\n')).not.toContain(ESC);
  });
});

describe('asking', () => {
  it('drives both questions off a stream and answers by key', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: string[] = [];
    output.on('data', (d: Buffer) => seen.push(d.toString()));
    const answers = ask([tools, language], { input, output, color: false });
    input.write(' '); // claude
    input.write(`${ESC}[B`); // 跳过灰显的 codex，落在 zed
    input.write(' '); // zed
    input.write('\r');
    input.write(' '); // 语言：光标在第一个，选中文
    input.write('\r');
    expect(await answers).toEqual({ platform: ['claude', 'zed'], language: ['zh-CN'] });
    expect(seen.join('')).toContain('Which language should the projected Skills use?');
  });
});

describe('what init offers (CLI-44)', () => {
  it('greys out what is not there, and opens everything up when nothing is', async () => {
    const { toolChoices } = await import('../../../src/assemble/index.js');
    const some = toolChoices({ XFORGE_DETECT: 'claude:2.1.0,codex:none' });
    expect(some.find((c) => c.value === 'claude')).toEqual({ value: 'claude', label: 'Claude Code', note: 'detected 2.1.0' });
    expect(some.find((c) => c.value === 'codex')).toMatchObject({ disabled: true, note: 'not detected' });
    const none = toolChoices({ XFORGE_DETECT: 'claude:none,codex:none' });
    expect(none.every((c) => c.disabled === undefined)).toBe(true);
    expect(none[0]?.note).toContain('files are written anyway');
  });
});
