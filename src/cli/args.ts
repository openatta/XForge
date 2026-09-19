// design: cli §1 — 参数解析：位置参数与 --key value / --key=value / --flag，不做别的。
export interface Parsed {
  positional: string[];
  /** 一个 key 可以出现多次；`true` 表示它是个开关，没有值。 */
  flags: Map<string, string[] | true>;
}

/**
 * 只认开关、不吃值的那些 `--flag`。没有这张表，`xforge show --text receipts`
 * 会把 `receipts` 当成 `--text` 的值吞掉，然后报「用法: xforge show <ref>」——
 * 一个看起来完全正确的命令行莫名其妙地失败（命令行设计 §1.2）。
 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'text', 'orient', 'all', 'hygiene', 'force', 'no-run', 'dispatch', 'deliver', 'archive', 'no-input', 'dry-run', 'status', 'finish', 'rollback',
]);

function add(flags: Map<string, string[] | true>, key: string, value: string): void {
  const prev = flags.get(key);
  // 重复给同一个 key 就累加，`--k a --k b` 与 `--k=a --k=b` 必须一样 ——
  // 两种写法给出不同结果，而且是静默的，比不支持其中一种更坏。
  flags.set(key, Array.isArray(prev) ? [...prev, value] : [value]);
}

export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[] | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      add(flags, arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags.set(key, true);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      add(flags, key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { positional, flags };
}

/** 最后一次给的值；没给过或它是个开关就是 undefined。 */
export function flagString(p: Parsed, key: string): string | undefined {
  const v = p.flags.get(key);
  return Array.isArray(v) ? v.at(-1) : undefined;
}

export function flagBool(p: Parsed, key: string): boolean {
  return p.flags.has(key);
}

/** 原样的每一次取值，不按逗号拆。值里本来就可能有逗号（`--command 'test=a,b'`）。 */
export function flagValues(p: Parsed, key: string): string[] {
  const v = p.flags.get(key);
  return Array.isArray(v) ? [...v] : [];
}

/** 可以给多次、也可以一次用逗号分隔的 `--key`（`--gate a,b` 与 `--gate a --gate b` 等价）。 */
export function flagList(p: Parsed, key: string): string[] {
  return flagValues(p, key).flatMap((v) => v.split(',').map((s) => s.trim())).filter(Boolean);
}
