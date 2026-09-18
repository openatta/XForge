// design: cli §5.4 — 交互的纯逻辑：按键怎么改状态、列表怎么画。终端不在这里，所以能直接测。
import { describe, expect, it } from 'vitest';
import { displayWidth, renderAnswer, renderQuestion, step, type Choice, type PromptState, type Question, type View } from '../../../src/cli/prompt.js';

const view: View = { dim: false, columns: 200 };

const choice = (id: string, available = true): Choice => ({ id, label: id.toUpperCase(), note: available ? 'found' : 'not detected', available });

const tools: Question = {
  title: 'Select the hosts to install into',
  hint: '(hint)',
  choices: [choice('claude'), choice('codex', false), choice('other')],
  multi: true,
  required: 'At least one tool must be selected.',
};

const language: Question = {
  title: 'Select the language',
  hint: '(hint)',
  choices: [choice('zh-CN'), choice('en')],
  multi: false,
};

const start = (cursor = 0): PromptState => ({ cursor, picked: [] });

/** 去掉颜色之后，这一行在终端上占几列 —— 终端按列折行，所以量的是列，不是字符。 */
const visible = (line: string): number => displayWidth(line.replace(/\u001b\[[0-9;]*m/g, ''));

/** 某段文字从第几列开始。 */
const columnOf = (line: string, part: string): number => displayWidth(line.slice(0, line.indexOf(part)));

describe('prompt: a keypress moves the state, and nothing else does', () => {
  it('the cursor only rests on choices you can pick', () => {
    const down = step(tools, start(0), 'down');
    expect(down.state.cursor).toBe(2); // codex 探测不到，光标跳过它
    expect(step(tools, down.state, 'up').state.cursor).toBe(0);
    expect(step(tools, start(0), 'up').state.cursor).toBe(0); // 到头就停住，不回绕
  });

  it('space toggles, and toggling again untoggles', () => {
    const on = step(tools, start(0), 'toggle');
    expect(on.state.picked).toEqual(['claude']);
    expect(step(tools, on.state, 'toggle').state.picked).toEqual([]);
  });

  it('a choice that was not detected cannot be picked, by any key', () => {
    const refused = step(tools, start(1), 'toggle'); // 光标停在 codex 上（显式构造的状态）
    expect(refused.state.picked).toEqual([]);
    expect(refused.refuse).toBe('CODEX is not detected.');
    expect(step(tools, start(1), 'confirm').done).toBe(false);
  });

  it('enter with nothing picked refuses and says why; picking one lets it through', () => {
    const refused = step(tools, start(0), 'confirm');
    expect(refused.done).toBe(false);
    expect(refused.refuse).toBe('At least one tool must be selected.');
    const on = step(tools, start(0), 'toggle');
    const done = step(tools, on.state, 'confirm');
    expect(done.done).toBe(true);
    expect(done.state.picked).toEqual(['claude']);
  });

  it('a single-select answers with the choice under the cursor', () => {
    const done = step(language, start(1), 'confirm');
    expect(done.done).toBe(true);
    expect(done.state.picked).toEqual(['en']);
    expect(step(language, start(0), 'toggle').state.picked).toEqual([]); // 空格在单选里不做任何事
  });

  it('escape and ctrl-c cancel; other keys change nothing', () => {
    expect(step(tools, start(0), 'cancel').cancel).toBe(true);
    const same = step(tools, start(0), 'other');
    expect(same.state).toEqual(start(0));
    expect(same.done).toBe(false);
  });
});

describe('prompt: the list as text', () => {
  it('marks the cursor, the picked boxes, and keeps every row inside the width', () => {
    const lines = renderQuestion(tools, { cursor: 0, picked: ['claude'] }, view);
    expect(lines[0]).toBe('? Select the hosts to install into   (hint)');
    expect(lines[1]).toContain('[✓] CLAUDE');
    expect(lines[2]).toContain('[ ] CODEX');
    expect(lines[2]).toContain('not detected');
    // 折行会让重画算错行数：可见宽度（不算颜色）必须装得下。
    for (const line of renderQuestion(tools, start(0), { dim: true, columns: 30 })) expect(visible(line)).toBeLessThanOrEqual(30);
  });

  it('moves a note that does not fit onto its own indented line instead of cutting it', () => {
    const long: Question = {
      title: 'Select the hosts to install into',
      hint: '(hint)',
      choices: [{ id: 'claude', label: 'Claude Code', note: 'Skills, an isolated executor, and the enforcement hook.', available: true }],
      multi: true,
    };
    const wide = renderQuestion(long, start(0), { dim: false, columns: 80 });
    expect(wide).toHaveLength(2); // 装得下就同行
    expect(wide[1]).toContain('Skills, an isolated executor');
    const narrow = renderQuestion(long, start(0), { dim: false, columns: 40 });
    expect(narrow).toHaveLength(3);
    expect(narrow[1]).toBe('❯ [ ] Claude Code');
    expect(narrow[2]).toBe('      Skills, an isolated executor, and…'); // 缩进对齐标签，仍不折行
    for (const line of narrow) expect(visible(line)).toBeLessThanOrEqual(40);
  });

  it('measures rows in columns, not characters — a label in Chinese takes two columns a glyph', () => {
    expect(displayWidth('中文（简体）')).toBe(12);
    const lang: Question = {
      title: 'Select the language for generated Skills',
      hint: '(hint)',
      multi: false,
      choices: [
        { id: 'zh-CN', label: '中文（简体）', note: 'in Chinese', available: true },
        { id: 'en', label: 'English', note: 'in English', available: true },
      ],
    };
    const lines = renderQuestion(lang, start(0), { dim: false, columns: 200 });
    // 英文标签补到中文标签的宽度上：两行的备注从同一列开始。
    expect(columnOf(lines[2]!, 'in English')).toBe(columnOf(lines[1]!, 'in Chinese'));
    // 中文行自己也装得下，不因为按字符算而被截。
    for (const line of lines) expect(visible(line)).toBeLessThanOrEqual(200);
  });

  it('dims what cannot be picked only when the terminal can show it', () => {
    const dimmed = renderQuestion(tools, start(0), { dim: true, columns: 200 })[2]!;
    const plain = renderQuestion(tools, start(0), view)[2]!;
    expect(dimmed).toContain('\u001b[2m');
    expect(plain).not.toContain('\u001b[');
  });

  it('the refusal is drawn under the list, and the answer line names what was picked', () => {
    const refused = renderQuestion(tools, start(0), view, 'At least one tool must be selected.');
    expect(refused.at(-1)).toContain('At least one tool must be selected.');
    expect(renderAnswer(tools, { cursor: 0, picked: ['claude', 'other'] }, view)).toEqual(['? Select the hosts to install into', '  ✓ CLAUDE, OTHER']);
  });
});
