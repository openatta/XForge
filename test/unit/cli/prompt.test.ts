// design: cli §5.1 — CLI-44 的组件那一半：按键 → 状态 → 画面是纯函数，灰显不可选，必选未满足不放行；CLI-51：按列算宽度、读具名键。
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { ask, clip, displayWidth, initialState, keyOf, onKey, renderAnswer, renderQuestion, type Question, type View } from '../../../src/cli/prompt.js';

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
  it('reads the named keys a terminal reports, not raw escape bytes', () => {
    expect(keyOf(undefined, { name: 'up' })).toBe('up');
    expect(keyOf(undefined, { name: 'down' })).toBe('down');
    expect(keyOf('k', { name: 'k' })).toBe('up');
    expect(keyOf(' ', { name: 'space' })).toBe('space');
    expect(keyOf('\r', { name: 'return' })).toBe('enter');
    expect(keyOf(undefined, { name: 'c', ctrl: true })).toBe('abort');
    expect(keyOf(undefined, { name: 'escape' })).toBe('abort');
    expect(keyOf('x', { name: 'x' })).toBe('other');
    // 方向键发的是 ESC [ A：自己解转义序列就得赌它不被拆包，裸 ESC 会被当成取消。
    expect(keyOf(ESC, { name: 'up' })).toBe('up');
  });
});

describe('width', () => {
  it('counts columns, not characters: CJK takes two', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('a中')).toBe(3);
  });

  it('clips a line to what the terminal can hold — a wrapped line breaks the redraw', () => {
    expect(clip('abcdef', 80)).toBe('abcdef');
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(displayWidth(clip('中文中文中文', 7))).toBeLessThanOrEqual(7);
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

  it('单选：光标停在哪就是答案，不用先按空格（CLI-53）', () => {
    const start = initialState(language);
    expect(start).toEqual({ cursor: 0, selected: ['zh-CN'] });
    const moved = onKey(language, start, 'down');
    expect(moved.state.cursor).toBe(1);
    expect(moved.state.selected).toEqual(['en']); // 移动光标就换了答案
    expect(onKey(language, moved.state, 'space').state.selected).toEqual(['en']); // 空格在单选里什么都不做
    expect(onKey(language, moved.state, 'enter').done).toBe(true);
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
    const view: View = { color: false, columns: 200 };
    const lines = renderQuestion(tools, { cursor: 0, selected: ['claude'] }, view);
    expect(lines[0]).toBe('? Which AI coding tools should XForge project into? (space to select, enter to confirm)');
    expect(lines[1]).toBe('> [✓] Claude Code  detected 2.1.0');
    expect(lines[2]).toBe('  [ ] Codex CLI  not detected');
    expect(lines[3]).toBe('  [ ] Zed  detected');
    expect(lines.join('\n')).not.toContain(ESC);
  });

  it('答完收起成两行回执，不留带光标的半截画面（CLI-53）', () => {
    const view: View = { color: false, columns: 200 };
    expect(renderAnswer(tools, { cursor: 0, selected: ['claude', 'zed'] }, view)).toEqual([
      '? Which AI coding tools should XForge project into?',
      '  ✓ Claude Code, Zed',
    ]);
  });

  it('every line fits the terminal, so the redraw can count rows', () => {
    const narrow = renderQuestion(tools, { cursor: 0, selected: [] }, { color: false, columns: 30 });
    for (const l of narrow) expect(displayWidth(l)).toBeLessThanOrEqual(30);
  });
});

describe('asking', () => {
  it('drives both questions off a stream and answers by key', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: string[] = [];
    output.on('data', (d: Buffer) => seen.push(d.toString()));
    const answers = ask([tools, language], { input, output, view: { color: false, columns: 200 } });
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
