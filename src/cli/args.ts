// design: cli §1 — 参数解析：位置参数与 --key value / --flag，不做别的。
export interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        const prev = flags.get(key);
        flags.set(key, typeof prev === 'string' ? `${prev},${next}` : next);
        i += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

export function flagString(p: Parsed, key: string): string | undefined {
  const v = p.flags.get(key);
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(p: Parsed, key: string): boolean {
  return p.flags.has(key);
}

/** 允许重复的 --key（如 --gate a --gate b 写成 --gate a,b 或多次）；这里按逗号拆。 */
export function flagList(p: Parsed, key: string): string[] {
  const v = flagString(p, key);
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}
