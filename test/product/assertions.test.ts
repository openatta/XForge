// design: migration §0 — D9 的另一半：设计里每条编号断言都有测试引用它，除非这里说明为什么不能。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 不能由合并门里的测试证明的断言，每条一个理由；live 层的在 test/live 里取数。 */
const NOT_PROVABLE_HERE: Record<string, string> = {
  'MG-08': '提交信息的约定，是 git 历史的事实，不是代码行为',
  'RF-10': '「永不解析」是反面断言：没有代码读 instructions 的内容，由代码评审保证',
  'CLI-03': '系统调用级的「不写盘」没有便携的断言手段；信封 changed 恒空由走查覆盖',
  'LT-04': 'live 层：每轮的 prompt / stream / result 落盘由 runTurn 做，需要真实的 claude 进程',
  'CLI-09': 'live 层：顺利的 Change 全程不调 inspect，从转录里数',
  'CLI-27': 'live 层：inspect 只由 advance --archive 内部调一次，从转录里数',
  'CLI-29': 'live 层：show 调用数 ≥ 直读数，summary.observations',
  'SK-06': 'live 层：包执行者不整读设计，从转录里数',
  'SK-07': 'harness 拼简报的顺序，由 test/live/harness/run.ts 决定',
  'SK-10': 'live 层：两宿主产出相同；codex 尚不能非交互驱动',
  'SK-11': 'live 层：设计文档整读次数，summary.observations',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') || p.endsWith('.md')) out.push(p);
  }
  return out;
}

describe('design assertions', () => {
  const designs = readdirSync(join(root, 'docs', 'design')).filter((f) => f.endsWith('.md'));
  const defined = new Set<string>();
  for (const f of designs) for (const m of readFileSync(join(root, 'docs', 'design', f), 'utf8').matchAll(/^`((?:MG|RF|CLI|SK|LT)-\d{2})`/gm)) defined.add(m[1]!);
  const referenced = new Set<string>();
  const self = fileURLToPath(import.meta.url);
  for (const f of [...walk(join(root, 'test')), ...walk(join(root, 'src'))]) {
    if (f === self) continue; // 本文件里的理由清单不算引用
    for (const m of readFileSync(f, 'utf8').matchAll(/\b((?:MG|RF|CLI|SK|LT)-\d{2})\b/g)) referenced.add(m[1]!);
  }

  it('every numbered assertion is referenced by a test or source file, or excused here with a reason', () => {
    const missing = [...defined].filter((id) => !referenced.has(id) && !(id in NOT_PROVABLE_HERE)).sort();
    expect(missing, `未被任何测试引用、也没有理由的断言：${missing.join(' ')}`).toEqual([]);
  });

  it('every excuse names an assertion that still exists and is not already covered', () => {
    for (const id of Object.keys(NOT_PROVABLE_HERE)) {
      expect(defined.has(id), `${id} 已不在设计里，删掉它的理由`).toBe(true);
      expect(referenced.has(id), `${id} 已经有测试引用了，删掉它的理由`).toBe(false);
    }
  });
});
