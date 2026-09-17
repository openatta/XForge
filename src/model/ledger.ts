// design: rule-files §5.2 — 台账一个形状：哪些条目需署名、署名与审计事件怎么对。
import { ID } from './ids.js';
import type { Ledger, LedgerEntry } from './types.js';

const SIGN_ON: Record<string, ReadonlyArray<string> | 'all'> = {
  'review-findings': ['resolved', 'rejected'],
  'constitution-reply': ['violates'],
  'verification-receipt': 'all',
  delivery: 'all',
};

/** 这条需要人（或执行者）负责吗。 */
export function requiresSignature(kind: string, entry: Pick<LedgerEntry, 'conclusion'>): boolean {
  if (kind.startsWith('exit/')) return true;
  const rule = SIGN_ON[kind];
  if (!rule) return false;
  return rule === 'all' || rule.includes(entry.conclusion);
}

/**
 * RF-21：signer 与 at 成对；执行 id 作 signer 时必须是 EX- 格式（派工 receipt 是否存在由命令层核对）。
 * 缺署名不是形状错误：台账由 Agent 写，署名由人在登记前补上；缺失由 `attested` 出口条件报 attest-missing。
 */
export function validateLedger(ledger: Ledger): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const e of ledger.entries) {
    if (seen.has(e.id)) errors.push(`条目 id 重复: ${e.id}`);
    seen.add(e.id);
    if ((e.signer && !e.at) || (!e.signer && e.at)) errors.push(`条目 ${e.id} 的 signer 与 at 必须成对`);
    if (ledger.kind === 'delivery') {
      if (!e.signer) errors.push(`交付记录 ${e.id} 必须由执行者署名`);
      if (e.signer && !ID.execution.test(e.signer)) errors.push(`交付记录 ${e.id} 的 signer 必须是执行 id`);
      if (e.signer && e.signer !== e.id) errors.push(`交付记录 ${e.id} 的 signer 必须等于它的 id`);
    }
  }
  return errors;
}

/** 审计事件的 kind 与台账种类的对应（§5.3 表）。 */
export function auditKindFor(ledgerKind: string): 'finding.answered' | 'entry.decided' | 'receipt.signed' | null {
  if (ledgerKind === 'review-findings') return 'finding.answered';
  if (ledgerKind === 'constitution-reply' || ledgerKind.startsWith('exit/')) return 'entry.decided';
  if (ledgerKind === 'verification-receipt') return 'receipt.signed';
  return null;
}

export function entriesNeedingSignature(ledger: Ledger): LedgerEntry[] {
  return ledger.entries.filter((e) => requiresSignature(ledger.kind, e));
}
