// design: rule-files §0 — D10：各类 id 的字面形状。
import { randomBytes } from 'node:crypto';

export const ID = {
  change: /^C-\d{8}-[a-z0-9][a-z0-9-]*$/,
  execution: /^EX-\d{8}-[a-z0-9]{6}$/,
  receipt: /^R-\d{4}$/,
  requirement: /^REQ-[a-z0-9-]+-[a-z0-9-]+-\d{3}$/,
  element: /^(fn|type|endpoint|event|cli|schema):.+$/,
  finding: /^F-\d{3}$/,
  package: /^P-\d{2,}$/,
  ledgerRef: /^(review-findings|constitution-reply|verification-receipt|delivery|exit\/[a-z][a-z0-9-]*)$/,
  /** 具名实现方案的 id；`default` 不占名字，规格侧目录名不能用。 */
  scheme: /^[a-z][a-z0-9-]*$/,
} as const;

/** Change 目录里不是方案的子目录：规格侧与实现侧的固定名字。 */
export const RESERVED_IN_CHANGE = new Set(['specs', 'interfaces', 'ledgers', 'evidence']);

export function isSchemeId(id: string): boolean {
  return id !== 'default' && ID.scheme.test(id) && !RESERVED_IN_CHANGE.has(id);
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * 标题 → Change id 里的那一段。**产出必须合 `ID.change`**：那条正则只认小写字母数字与连字符，
 * 所以这里也只留它们 —— 曾经放行过 CJK，结果是中文标题直接把 `newChangeId` 抛掉，
 * 而不是退回缺省。一个纯非 ASCII 的标题回 `change`，由人改。
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9]/.test(slug) ? slug : 'change';
}

export function newChangeId(slug: string, date = new Date()): string {
  const id = `C-${yyyymmdd(date)}-${slugify(slug)}`;
  if (!ID.change.test(id)) throw new Error(`Change id 不合法: ${id}`);
  return id;
}

export function newExecutionId(date = new Date(), random: () => Buffer = () => randomBytes(6)): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  // 六个字符要六个字节：四个字节绕着用，第 5、6 位就是第 1、2 位的函数。
  const bytes = random();
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += alphabet[(bytes[i % bytes.length] ?? 0) % alphabet.length];
  return `EX-${yyyymmdd(date)}-${suffix}`;
}

export function receiptId(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 9999) throw new Error(`receipt seq 越界: ${seq}`);
  return `R-${String(seq).padStart(4, '0')}`;
}

export function receiptSeq(id: string): number {
  if (!ID.receipt.test(id)) throw new Error(`receipt id 不合法: ${id}`);
  return Number(id.slice(2));
}
