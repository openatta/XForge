// design: rule-files §5.3 — 审计链：hash 覆盖 prev，可选 HMAC；署名匹配规则。
import { hmacSha256, recordHash } from './digest.js';
import { ModelError } from './errors.js';
import type { AuditActor, AuditEvent, LedgerEntry } from './types.js';

export const AUDIT_HMAC_ENV = 'XFORGE_AUDIT_HMAC';

export function actorString(actor: AuditActor): string {
  return `${actor.name} <${actor.email}>`;
}

export function eventHash(event: Omit<AuditEvent, 'hash' | 'hmac'>): string {
  return recordHash(event as unknown as Record<string, unknown>);
}

export function sealEvent(body: Omit<AuditEvent, 'hash' | 'hmac'>, secret: string | undefined): AuditEvent {
  const hash = eventHash(body);
  return { ...body, hash, hmac: secret ? hmacSha256(secret, hash) : null };
}

export interface AuditProblem {
  code: 'XF-INSPECT-004';
  seq: number;
  severity: 'blocking' | 'info';
  message: string;
}

/** RF-25：逐条验 prev / hash；设了密钥则验 hmac；没设密钥只给提示。 */
export function verifyAuditChain(events: readonly AuditEvent[], secret: string | undefined): AuditProblem[] {
  const problems: AuditProblem[] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let prevHash: string | null = null;
  sorted.forEach((e, i) => {
    if (e.seq !== i + 1) problems.push({ code: 'XF-INSPECT-004', seq: e.seq, severity: 'blocking', message: `seq 不连续：期望 ${i + 1}` });
    if (e.prev !== prevHash) problems.push({ code: 'XF-INSPECT-004', seq: e.seq, severity: 'blocking', message: 'prev 与上一条 hash 不符' });
    const { hash, hmac, ...body } = e;
    if (eventHash(body) !== hash) problems.push({ code: 'XF-INSPECT-004', seq: e.seq, severity: 'blocking', message: 'hash 与内容不符' });
    if (secret) {
      if (hmac !== hmacSha256(secret, hash)) problems.push({ code: 'XF-INSPECT-004', seq: e.seq, severity: 'blocking', message: 'hmac 校验失败' });
    }
    prevHash = hash;
  });
  if (!secret && sorted.length) problems.push({ code: 'XF-INSPECT-004', seq: 0, severity: 'info', message: `未设置 ${AUDIT_HMAC_ENV}：审计链只能发现损坏` });
  return problems;
}

/**
 * 读审计链。坏行**不抛** —— `inspect` 的职责就是发现记录损坏，
 * 它自己因为一行坏 JSON 倒下，就什么也发现不了了（一次写到一半被杀就够）。
 */
export function parseChain(text: string): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim().length) continue;
    try {
      out.push(JSON.parse(line) as AuditEvent);
    } catch {
      throw new ModelError('XF-MODEL-001', `审计链第 ${i + 1} 行不是合法 JSON`, ['xforge/.audit/chain.jsonl']);
    }
  }
  return out;
}

export function serializeEvent(event: AuditEvent): string {
  return JSON.stringify(event) + '\n';
}

/**
 * 署名匹配（`署名可引用不可编造`）：条目的 signer 与某个事件的 actor 渲染逐字相等，
 * 事件 kind 对应台账种类，subject.digest 等于台账当时的 digest，subject.entry 等于条目 id。
 */
export function findSigningEvent(
  entry: Pick<LedgerEntry, 'id' | 'signer'>,
  events: readonly AuditEvent[],
  kind: AuditEvent['kind'],
  digest: string,
): AuditEvent | undefined {
  return events.find(
    (e) =>
      e.kind === kind &&
      actorString(e.actor) === entry.signer &&
      e.subject['digest'] === digest &&
      (e.subject['entry'] === undefined || e.subject['entry'] === entry.id),
  );
}
