// design: live-test §2 — 注入故障：设计里的矛盾句（经模型）；归档后改一个 receipt 字节（不经模型）。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { xforge } from './xforge.js';

export const PLANTED_SENTENCE = '部分收款后发票状态记为 paid。';

/** design 出站后，在《失败模式》一节末尾追加与验收套件矛盾的断言。 */
export function plantDesignFault(project: string, changeId: string): boolean {
  const path = join(project, 'xforge', 'changes', changeId, 'design.md');
  const text = readFileSync(path, 'utf8');
  if (text.includes(PLANTED_SENTENCE)) return false;
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^##\s+失败模式/.test(l));
  if (idx === -1) {
    writeFileSync(path, `${text.trimEnd()}\n\n${PLANTED_SENTENCE}\n`);
    return true;
  }
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  lines.splice(end, 0, PLANTED_SENTENCE, '');
  writeFileSync(path, lines.join('\n'));
  return true;
}

/** 归档后改第一环 receipt 的一个字节；期望 inspect 退出码 3 与 XF-INSPECT-001。改完恢复。 */
export async function tamperReceiptAndInspect(project: string, changeId: string): Promise<{ exit: number; codes: string[] }> {
  const dir = join(project, 'xforge', 'changes', changeId, 'evidence', 'receipts');
  const first = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()[0];
  if (!first) return { exit: -1, codes: [] };
  const path = join(dir, first);
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original.replace(/^to: (\S+)$/m, 'to: tampered'));
  try {
    const r = await xforge(project, ['inspect', '--change', changeId]);
    return { exit: r.exit, codes: r.env.diagnostics.map((d) => d.code) };
  } finally {
    writeFileSync(path, original);
  }
}
