// design: cli §5.1 — 装机那一屏：探测 → 多选工具 → 单选语言。按键 → 状态 → 画面是纯函数，UI 全部走 stderr。
import { emitKeypressEvents } from 'node:readline';

const ESC = String.fromCharCode(27);

export interface Choice {
  value: string;
  label: string;
  /** 跟在标签后面的一句说明（探测结果、为什么不能选）。 */
  note?: string;
  /** 灰显且不可选：本机没探测到。命令行上仍然可以点名（§5.1）。 */
  disabled?: boolean;
}

export interface Question {
  key: string;
  prompt: string;
  choices: Choice[];
  multi: boolean;
}

export interface SelectState {
  cursor: number;
  selected: string[];
  error?: string;
}

export type Key = 'up' | 'down' | 'space' | 'enter' | 'abort' | 'other';

/** 终端发来的一次按键（`readline` 的具名事件）→ 我们认得的按键。 */
export function keyOf(str: string | undefined, meta: { name?: string; ctrl?: boolean } | undefined): Key {
  if (meta?.ctrl && (meta.name === 'c' || meta.name === 'd')) return 'abort';
  switch (meta?.name) {
    case 'up':
    case 'k':
      return 'up';
    case 'down':
    case 'j':
      return 'down';
    case 'space':
      return 'space';
    case 'return':
    case 'enter':
      return 'enter';
    case 'escape':
      return 'abort';
    default:
      return str === ' ' ? 'space' : str === '\r' || str === '\n' ? 'enter' : 'other';
  }
}

const selectable = (q: Question): Choice[] => q.choices.filter((c) => !c.disabled);

export function initialState(q: Question): SelectState {
  const first = q.choices.findIndex((c) => !c.disabled);
  const cursor = first === -1 ? 0 : first;
  // 多选一开始什么都不选，人自己挑。单选没有「选」这个动作 —— 光标停在哪就是答案。
  return { cursor, selected: q.multi || !selectable(q).length ? [] : [q.choices[cursor]!.value] };
}

export interface Step {
  state: SelectState;
  done: boolean;
}

/** 一次按键：回新状态，以及这一问是不是答完了。不可选的项按不动，必选未满足不放行。 */
export function onKey(q: Question, state: SelectState, key: Key): Step {
  const next: SelectState = { cursor: state.cursor, selected: [...state.selected] };
  if (key === 'up' || key === 'down') {
    const step = key === 'up' ? -1 : 1;
    const n = q.choices.length;
    for (let i = 1; i <= n; i += 1) {
      const at = (((state.cursor + step * i) % n) + n) % n;
      if (!q.choices[at]!.disabled) {
        next.cursor = at;
        break;
      }
    }
    // 单选：光标就是答案，移到哪答案就是哪 —— 不该让人为一个单选题多按一次空格。
    if (!q.multi && !q.choices[next.cursor]!.disabled) next.selected = [q.choices[next.cursor]!.value];
    return { state: next, done: false };
  }
  if (key === 'space') {
    const choice = q.choices[state.cursor];
    if (!choice || !q.multi) return { state: next, done: false }; // 单选没有「切换」这一步
    if (choice.disabled) return { state: { ...next, error: `${choice.label} was not detected here; pass it on the command line to add it anyway.` }, done: false };
    next.selected = next.selected.includes(choice.value) ? next.selected.filter((v) => v !== choice.value) : [...next.selected, choice.value];
    return { state: next, done: false };
  }
  if (key === 'enter') {
    if (!next.selected.length) return { state: { ...next, error: 'Select at least one with space.' }, done: false };
    return { state: next, done: true };
  }
  return { state: next, done: false };
}

const DIM = `${ESC}[2m`;
const CYAN = `${ESC}[36m`;
const RESET = `${ESC}[0m`;

/** 零宽字符不占位，CJK 与 emoji 占两列。 */
const ZERO = /[̀-ͯ​-‏⁠︀-️]/;
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1f300}-\u{1faff}]|[\u{20000}-\u{3fffd}]/u;

/**
 * 一行占几列。**不是 `String.length`**：终端按列折行，而重画靠「往上退 N 行」，
 * 一旦有行折了，退的行数就错了，整屏花掉。中文标签的行按字符数算会短掉一半。
 */
export function displayWidth(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ZERO.test(ch)) continue;
    n += WIDE.test(ch) ? 2 : 1;
  }
  return n;
}

/** 截到装得下：宁可少一句话，也不能让画面折行。 */
export function clip(text: string, columns: number): string {
  if (columns <= 1 || displayWidth(text) <= columns) return text;
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

export interface View {
  /** 画面带不带颜色；`NO_COLOR` 与测试里关掉。 */
  color: boolean;
  /** 终端宽度。 */
  columns: number;
}

/** 一问的完整画面（行数组）。每行都已经截到 `columns` 之内。 */
export function renderQuestion(q: Question, state: SelectState, view: View): string[] {
  const dim = (t: string): string => (view.color ? `${DIM}${t}${RESET}` : t);
  const mark = (t: string): string => (view.color ? `${CYAN}${t}${RESET}` : t);
  const line = (t: string): string => clip(t, view.columns);
  const hint = q.multi ? '(space to select, enter to confirm)' : '(up/down to choose, enter to confirm)';
  const lines = [`${line(`? ${q.prompt} ${hint}`)}`];
  for (const [i, c] of q.choices.entries()) {
    const box = state.selected.includes(c.value) ? '[✓]' : '[ ]';
    const onCursor = i === state.cursor;
    // 先截再上色：转义序列不占列，算进宽度会把行截短。
    const body = line(`${onCursor ? '>' : ' '} ${box} ${c.label}${c.note ? `  ${c.note}` : ''}`);
    lines.push(c.disabled ? dim(body) : onCursor ? mark('>') + body.slice(1) : body);
  }
  if (state.error) lines.push(dim(line(`  ${state.error}`)));
  return lines;
}

/** 答完之后留在屏上的两行回执：问题 + 答案。带光标的半截画面不该留着。 */
export function renderAnswer(q: Question, state: SelectState, view: View): string[] {
  const picked = q.choices.filter((c) => state.selected.includes(c.value)).map((c) => c.label);
  return [clip(`? ${q.prompt}`, view.columns), clip(`  ✓ ${picked.join(', ')}`, view.columns)];
}

export interface Terminal {
  input: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => void; resume?: () => void; pause?: () => void };
  output: NodeJS.WritableStream;
  view: View;
}

export class Aborted extends Error {
  constructor() {
    super('aborted');
  }
}

/** 逐问问完。答案按 question.key 归组。人按 Esc / Ctrl-C 就抛，调用方当作「没答」。 */
export async function ask(questions: readonly Question[], term: Terminal): Promise<Record<string, string[]>> {
  const answers: Record<string, string[]> = {};
  emitKeypressEvents(term.input);
  term.input.setRawMode?.(true);
  term.input.resume?.();
  try {
    for (const q of questions) answers[q.key] = await askOne(q, term);
  } finally {
    term.input.setRawMode?.(false);
    term.input.pause?.();
  }
  return answers;
}

/**
 * 一问。用具名按键事件而不是自己解转义序列：方向键发的是 `ESC [ A`，
 * 自己解就得在「裸 ESC = 取消」与「ESC 是方向键的头一个字节」之间赌一把 —— 读被拆包就整个挂掉。
 */
async function askOne(q: Question, term: Terminal): Promise<string[]> {
  let state = initialState(q);
  let painted = 0;
  const paint = (lines: string[]): void => {
    if (painted) term.output.write(`${ESC}[${painted}A${ESC}[0J`);
    term.output.write(lines.join('\n') + '\n');
    painted = lines.length;
  };
  const draw = (): void => paint(renderQuestion(q, state, term.view));
  draw();
  return new Promise<string[]>((resolve, reject) => {
    // 按键可能比重画快（粘贴、连按）：先到的排队，一个都不丢。
    const done = (): void => {
      term.input.off('keypress', onKeypress);
      term.input.off('end', onEnd);
    };
    const onKeypress = (str: string | undefined, meta: { name?: string; ctrl?: boolean } | undefined): void => {
      const key = keyOf(str, meta);
      if (key === 'abort') {
        done();
        reject(new Aborted());
        return;
      }
      const step = onKey(q, state, key);
      state = step.state;
      if (step.done) {
        // 答完就收起：留在屏上的是两行回执，不是一幅带光标的半截画面。
        paint(renderAnswer(q, state, term.view));
        done();
        resolve(state.selected);
        return;
      }
      draw();
    };
    const onEnd = (): void => {
      done();
      reject(new Aborted());
    };
    term.input.on('keypress', onKeypress);
    term.input.once('end', onEnd);
  });
}
