// design: rule-files §5.3 — receipt 成链：hash 覆盖 prev；seq 连续；逐环验。
import { recordHash } from './digest.js';
import { receiptId } from './ids.js';
import type { Receipt } from './types.js';

export function receiptHash(receipt: Omit<Receipt, 'hash'>): string {
  return recordHash(receipt as unknown as Record<string, unknown>);
}

export function sealReceipt(body: Omit<Receipt, 'hash' | 'id'>): Receipt {
  const withId = { ...body, id: receiptId(body.seq) };
  return { ...withId, hash: receiptHash(withId) };
}

export interface ChainProblem {
  code: 'XF-INSPECT-001';
  seq: number;
  message: string;
}

/** RF-23 / RF-24：按 seq 排序后逐环验 seq 连续、prev 等于上一环 hash、hash 等于自身重算。 */
export function verifyReceiptChain(receipts: readonly Receipt[]): ChainProblem[] {
  const problems: ChainProblem[] = [];
  const sorted = [...receipts].sort((a, b) => a.seq - b.seq);
  let prevHash: string | null = null;
  sorted.forEach((r, i) => {
    if (r.seq !== i + 1) problems.push({ code: 'XF-INSPECT-001', seq: r.seq, message: `seq 不连续：期望 ${i + 1}` });
    if (r.prev !== prevHash) problems.push({ code: 'XF-INSPECT-001', seq: r.seq, message: 'prev 与上一环 hash 不符' });
    const { hash, ...body } = r;
    if (receiptHash(body) !== hash) problems.push({ code: 'XF-INSPECT-001', seq: r.seq, message: 'hash 与内容不符' });
    prevHash = hash;
  });
  return problems;
}

export function lastReceipt(receipts: readonly Receipt[]): Receipt | undefined {
  return [...receipts].sort((a, b) => a.seq - b.seq).at(-1);
}
