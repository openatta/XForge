// design: cli §5.1 — 装机那一屏：探测 → 多选工具 → 单选语言。按键 → 状态 → 渲染是纯函数，UI 全部走 stderr。
const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

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

/** 终端字节序列 → 我们认得的按键。 */
export function decodeKey(seq: string): Key {
  if (seq === CTRL_C || seq === ESC) return 'abort';
  if (seq === '\r' || seq === '\n') return 'enter';
  if (seq === ' ') return 'space';
  if (seq === `${ESC}[A` || seq === 'k') return 'up';
  if (seq === `${ESC}[B` || seq === 'j') return 'down';
  return 'other';
}

const selectable = (q: Question): Choice[] => q.choices.filter((c) => !c.disabled);

export function initialState(q: Question): SelectState {
  const first = q.choices.findIndex((c) => !c.disabled);
  const cursor = first === -1 ? 0 : first;
  // 单选给一个缺省（第一个可选的）；多选一开始什么都不选，人自己挑。
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
    return { state: next, done: false };
  }
  if (key === 'space') {
    const choice = q.choices[state.cursor];
    if (!choice) return { state: next, done: false };
    if (choice.disabled) return { state: { ...next, error: `${choice.label} was not detected here; pass it on the command line to add it anyway.` }, done: false };
    if (q.multi) next.selected = next.selected.includes(choice.value) ? next.selected.filter((v) => v !== choice.value) : [...next.selected, choice.value];
    else next.selected = [choice.value];
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

/** 一问的完整画面（行数组）。`color` 关掉时不带任何转义，好断言。 */
export function renderQuestion(q: Question, state: SelectState, color = true): string[] {
  const dim = (t: string): string => (color ? `${DIM}${t}${RESET}` : t);
  const mark = (t: string): string => (color ? `${CYAN}${t}${RESET}` : t);
  const lines = [`? ${q.prompt} ${dim(q.multi ? '(space to select, enter to confirm)' : '(space to choose, enter to confirm)')}`];
  for (const [i, c] of q.choices.entries()) {
    const box = state.selected.includes(c.value) ? '[x]' : '[ ]';
    const head = i === state.cursor ? mark('>') : ' ';
    const body = `${head} ${box} ${c.label}${c.note ? `  ${c.note}` : ''}`;
    lines.push(c.disabled ? dim(body) : body);
  }
  if (state.error) lines.push(dim(`  ${state.error}`));
  return lines;
}

export interface Terminal {
  input: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => void; resume?: () => void; pause?: () => void };
  output: NodeJS.WritableStream;
  /** 画面带不带颜色；测试里关掉。 */
  color?: boolean;
}

export class Aborted extends Error {
  constructor() {
    super('aborted');
  }
}

/** 逐问问完。答案按 question.key 归组。人按 Esc / Ctrl-C 就抛，调用方当作「没答」。 */
export async function ask(questions: readonly Question[], term: Terminal): Promise<Record<string, string[]>> {
  const answers: Record<string, string[]> = {};
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
 * 一问。用 data 监听而不是 for-await：后者在 return 时会把流关掉，
 * 第二问就没得读了（同一个 stdin 要问好几遍）。
 */
async function askOne(q: Question, term: Terminal): Promise<string[]> {
  let state = initialState(q);
  let painted = 0;
  const paint = (): void => {
    if (painted) term.output.write(`${ESC}[${painted}A${ESC}[0J`);
    const lines = renderQuestion(q, state, term.color !== false);
    term.output.write(lines.join('\n') + '\n');
    painted = lines.length;
  };
  paint();
  return new Promise<string[]>((resolve, reject) => {
    const done = (): void => {
      term.input.off('data', onData);
      term.input.off('end', onEnd);
    };
    const onData = (chunk: Buffer | string): void => {
      const key = decodeKey(chunk.toString());
      if (key === 'abort') {
        done();
        reject(new Aborted());
        return;
      }
      const step = onKey(q, state, key);
      state = step.state;
      paint();
      if (step.done) {
        done();
        resolve(state.selected);
      }
    };
    const onEnd = (): void => {
      done();
      reject(new Aborted());
    };
    term.input.on('data', onData);
    term.input.once('end', onEnd);
  });
}
