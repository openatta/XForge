// design: cli §5.4 — 交互：问题画在 stderr，按键读成答案；stdout 只有一个东西 —— 信封。
import { emitKeypressEvents } from 'node:readline';
import type { Io } from './envelope.js';
import { CliError } from './errors.js';

/** 一行选项。`available: false` 的项灰掉且不可勾选 —— 探测不到的宿主不该被「顺手选中」。 */
export interface Choice {
  id: string;
  label: string;
  note: string;
  available: boolean;
}

export interface Question {
  title: string;
  hint: string;
  choices: Choice[];
  multi: boolean;
  /** 多选：一个都没勾就回车时给的理由。单选不需要（光标停着的那项就是答案）。 */
  required?: string;
}

/** 光标位置 + 已勾选的 id。纯数据：`step` 之外没有人改它。 */
export interface PromptState {
  cursor: number;
  picked: string[];
}

export type Key = 'up' | 'down' | 'toggle' | 'confirm' | 'cancel' | 'other';

export interface Step {
  state: PromptState;
  done: boolean;
  cancel: boolean;
  /** 这次按键被拒绝的理由（画在列表下面），下一次按键清掉。 */
  refuse?: string;
}

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';
const CURSOR = '❯';

/** 可选项的行号；一个都没有时回 -1。光标只在能勾的项之间走。 */
function firstAvailable(q: Question): number {
  return q.choices.findIndex((c) => c.available);
}

function move(q: Question, from: number, delta: number): number {
  for (let i = from + delta; i >= 0 && i < q.choices.length; i += delta) if (q.choices[i]!.available) return i;
  return from;
}

/** 一次按键 → 下一个状态。这是交互的全部逻辑，与终端无关，所以能直接测。 */
export function step(q: Question, s: PromptState, key: Key): Step {
  const at = q.choices[s.cursor];
  switch (key) {
    case 'up':
      return { state: { ...s, cursor: move(q, s.cursor, -1) }, done: false, cancel: false };
    case 'down':
      return { state: { ...s, cursor: move(q, s.cursor, 1) }, done: false, cancel: false };
    case 'toggle': {
      if (q.multi) {
        if (!at) return { state: s, done: false, cancel: false, refuse: q.required ?? 'Nothing to select.' };
        if (!at.available) return { state: s, done: false, cancel: false, refuse: `${at.label} is not detected.` };
        const picked = s.picked.includes(at.id) ? s.picked.filter((id) => id !== at.id) : [...s.picked, at.id];
        return { state: { ...s, picked }, done: false, cancel: false };
      }
      return { state: s, done: false, cancel: false };
    }
    case 'confirm': {
      if (!q.multi) {
        if (!at?.available) return { state: s, done: false, cancel: false, refuse: q.required ?? 'Nothing to select.' };
        return { state: { ...s, picked: [at.id] }, done: true, cancel: false };
      }
      if (s.picked.length === 0) return { state: s, done: false, cancel: false, refuse: q.required ?? 'Pick at least one.' };
      return { state: s, done: true, cancel: false };
    }
    case 'cancel':
      return { state: s, done: false, cancel: true };
    default:
      return { state: s, done: false, cancel: false };
  }
}

/** 呈现方式：`dim` 是把不可选项画灰（`NO_COLOR` 下退化成纯文本），`columns` 是重画算法能承受的行宽。 */
export interface View {
  dim: boolean;
  columns: number;
}

/**
 * 显示宽度：终端是按**列**折行的，CJK 全角占两列。
 * 按 `String.length` 算，中文标签的行会算短一半 —— 折行一出现，「往上退 N 行」就退错了。
 */
const ZERO = /[\u0300-\u036f\u200b-\u200f\u2060\ufe00-\ufe0f]/;
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1f64f}]|[\u{1f900}-\u{1f9ff}]|[\u{20000}-\u{3fffd}]/u;

export function displayWidth(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ZERO.test(ch)) continue;
    n += WIDE.test(ch) ? 2 : 1;
  }
  return n;
}

function pad(text: string, columns: number): string {
  return text + ' '.repeat(Math.max(0, columns - displayWidth(text)));
}

/** 折行会让「往上退 N 行」算错，所以每行都必须先截到自己装得下。 */
function clip(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > columns - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/**
 * 列表当前的样子。光标那一列占两个字符，所以有没有光标都不左右晃。
 * 备注装得下就同行，装不下就换到下一行缩进 —— 八十列的终端上也不该被切掉半句。
 */
export function renderQuestion(q: Question, s: PromptState, view: View, refuse?: string): string[] {
  const width = Math.max(0, ...q.choices.map((c) => displayWidth(c.label)));
  const lines = [clip(`? ${q.title}   ${q.hint}`, view.columns)];
  q.choices.forEach((c, i) => {
    const onCursor = i === s.cursor;
    const box = c.available && s.picked.includes(c.id) ? '[✓]' : '[ ]';
    const head = `${(onCursor ? CURSOR : ' ').padEnd(2)}${box} ${pad(c.label, width)}`;
    const body =
      displayWidth(head) + 2 + displayWidth(c.note) > view.columns
        ? [clip(head.trimEnd(), view.columns), clip(`      ${c.note}`, view.columns)]
        : [`${head}  ${c.note}`];
    for (const line of body) lines.push(view.dim && !c.available ? `${DIM}${line}${RESET}` : line);
  });
  if (refuse) {
    const text = clip(`  ${refuse}`, view.columns);
    lines.push(view.dim ? `${DIM}${text}${RESET}` : text);
  }
  return lines;
}

/** 答完之后的定格：一行问题 + 一行答案，留在屏幕上当回执。 */
export function renderAnswer(q: Question, s: PromptState, view: View): string[] {
  const picked = q.choices.filter((c) => s.picked.includes(c.id)).map((c) => c.label);
  return [clip(`? ${q.title}`, view.columns), clip(`  ✓ ${picked.join(', ')}`, view.columns)];
}

/**
 * 光标移动要**重画**：块内每次擦掉重写，块之前的行留着。
 * 行数只按自己写出去的行数算 —— 所以每行都得短到不折行。
 */
class Screen {
  private committed: string[] = [];
  private live: string[] = [];
  private drawn = 0;

  constructor(private readonly out: NodeJS.WritableStream) {}

  paint(live: string[]): void {
    this.live = live;
    this.flush();
  }

  commit(lines: string[]): void {
    this.committed.push(...lines);
    this.live = [];
    this.flush();
  }

  /** 收尾：把活动块擦掉，留在屏幕上的是每个问题的问题行与答案行。 */
  finish(): void {
    if (this.drawn === 0 && this.live.length === 0) return;
    this.live = [];
    this.flush();
  }

  private flush(): void {
    if (this.drawn) this.out.write(`\u001b[${this.drawn}A\u001b[0J`);
    const lines = [...this.committed, ...this.live];
    if (lines.length) this.out.write(lines.join('\n') + '\n');
    this.drawn = lines.length;
  }
}

function toKey(str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): Key {
  const name = key?.name;
  if (key?.ctrl && name === 'c') return 'cancel';
  if (key?.ctrl && name === 'd') return 'cancel';
  switch (name) {
    case 'up':
    case 'k':
      return 'up';
    case 'down':
    case 'j':
      return 'down';
    case 'space':
      return 'toggle';
    case 'return':
    case 'enter':
      return 'confirm';
    case 'escape':
    case 'q':
      return 'cancel';
    default:
      return str === ' ' ? 'toggle' : 'other';
  }
}

function cancelled(): CliError {
  return new CliError('XF-ASSEMBLE-006', '交互被打断了', 1, { command: 'xforge init --platform claude', text: '想好了再答，或者一开始就把答案用 flag 说出来' });
}

/**
 * 依次问完所有问题，回每题的答案 id（多选按选项顺序）。
 * 取消（`Ctrl-C` / `Esc` / 输入结束）是人的决定，不是错误 —— 但也不该假装答完了。
 */
export async function askAll(io: Io, questions: readonly Question[], view: View): Promise<string[][]> {
  const stdin = io.stdin as NodeJS.ReadableStream & { setRawMode?(mode: boolean): void };
  const screen = new Screen(io.stderr);
  const raw = typeof stdin.setRawMode === 'function';
  emitKeypressEvents(stdin);
  const answers: string[][] = [];
  // 按键可能比重画快（粘贴、连按）：先到的一律排队，一个都不丢。
  const queue: Key[] = [];
  const waiting: Array<(key: Key) => void> = [];
  const push = (key: Key): void => {
    const wake = waiting.shift();
    if (wake) wake(key);
    else queue.push(key);
  };
  const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => push(toKey(str, key));
  const onEnd = (): void => push('cancel');
  stdin.on('keypress', onKey);
  stdin.on('end', onEnd);
  if (raw) stdin.setRawMode!(true);
  const next = (): Promise<Key> => {
    const ready = queue.shift();
    return ready ? Promise.resolve(ready) : new Promise<Key>((resolve) => waiting.push(resolve));
  };
  try {
    for (const q of questions) {
      let state: PromptState = { cursor: Math.max(0, firstAvailable(q)), picked: [] };
      let refuse: string | undefined;
      screen.paint(renderQuestion(q, state, view, refuse));
      for (;;) {
        const step_ = step(q, state, await next());
        if (step_.cancel) throw cancelled();
        state = step_.state;
        refuse = step_.refuse;
        if (step_.done) break;
        screen.paint(renderQuestion(q, state, view, refuse));
      }
      screen.commit(renderAnswer(q, state, view));
      answers.push(q.choices.filter((c) => state.picked.includes(c.id)).map((c) => c.id));
    }
    return answers;
  } finally {
    stdin.removeListener('keypress', onKey);
    stdin.removeListener('end', onEnd);
    if (raw) stdin.setRawMode!(false);
    screen.finish();
    stdin.pause?.();
  }
}
