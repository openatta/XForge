// design: rule-files §5.3 — 审计链只增不改；每条事件同时进本 Change 的审计索引。
import { AUDIT_HMAC_ENV, parseChain, sealEvent, serializeEvent } from '../model/audit.js';
import type { GovernancePaths } from '../model/paths.js';
import type { AuditActor, AuditEvent, AuditIndex, AuditKind } from '../model/types.js';
import { toYaml } from '../model/yaml.js';
import { readText, type Transaction } from '../fs/transaction.js';

export async function readChain(paths: GovernancePaths): Promise<AuditEvent[]> {
  const text = await readText(paths.auditChain);
  return text ? parseChain(text) : [];
}

export interface NewEvent {
  kind: AuditKind;
  change?: string;
  scheme?: string;
  subject: Record<string, unknown>;
  actor: AuditActor;
  decision?: 'approved' | 'rejected';
  refs?: string[];
  note?: string;
  via?: string;
  requested_by?: string;
  evidence?: string;
}

/** 在事务里追加一条事件；返回封好的事件（hash 已知，可被同一事务里的 receipt 引用）。 */
export async function appendEvent(
  tx: Transaction,
  paths: GovernancePaths,
  chain: readonly AuditEvent[],
  event: NewEvent,
  env: NodeJS.ProcessEnv,
  now: string,
  auditIndexPath?: string,
  currentIndex?: AuditIndex,
): Promise<AuditEvent> {
  const last = chain.at(-1);
  const body: Omit<AuditEvent, 'hash' | 'hmac'> = {
    seq: (last?.seq ?? 0) + 1,
    at: now,
    kind: event.kind,
    subject: event.subject,
    actor: event.actor,
    refs: event.refs ?? [],
    prev: last?.hash ?? null,
  };
  if (event.change) body.change = event.change;
  if (event.scheme) body.scheme = event.scheme;
  if (event.decision) body.decision = event.decision;
  if (event.note) body.note = event.note;
  if (event.via) body.via = event.via;
  if (event.requested_by) body.requested_by = event.requested_by;
  if (event.evidence) body.evidence = event.evidence;
  const sealed = sealEvent(body, env[AUDIT_HMAC_ENV]);
  tx.append(paths.auditChain, serializeEvent(sealed));
  if (auditIndexPath) {
    const index: AuditIndex = { events: [...(currentIndex?.events ?? []), { hash: sealed.hash, kind: sealed.kind, at: sealed.at }] };
    tx.write(auditIndexPath, toYaml(index));
  }
  return sealed;
}

export function eventsFor(chain: readonly AuditEvent[], change: string, scheme: string, opts: { includeArchive?: boolean; sharedStages?: readonly string[] } = {}): AuditEvent[] {
  // 归档是 Change 级（主文档 6.3）：archive 主题的审批事件不分方案；规格侧的站（流程里 scope: change，如 clarify）同理。
  const shared = (e: AuditEvent): boolean => (opts.includeArchive === true && e.subject['archive'] === true) || (opts.sharedStages ?? []).includes(String(e.subject['stage']));
  return chain.filter((e) => e.change === change && ((e.scheme ?? scheme) === scheme || shared(e)));
}
