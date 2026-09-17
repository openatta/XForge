// design: rule-files §5.3 — RF-23、RF-24、RF-25，署名匹配。
import { describe, expect, it } from 'vitest';
import { actorString, findSigningEvent, parseChain, sealEvent, serializeEvent, verifyAuditChain } from '../../../src/model/audit.js';
import { sealReceipt, verifyReceiptChain } from '../../../src/model/receipt.js';
import type { AuditEvent, Receipt } from '../../../src/model/types.js';

const AT = '2026-09-15T10:00:00Z';

function chainOf(n: number): Receipt[] {
  const out: Receipt[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= n; seq += 1) {
    const r = sealReceipt({ seq, kind: 'stage-transition', at: AT, change: 'C-20260915-x', scheme: 'default', prev, from: `s${seq}`, to: `s${seq + 1}`, subject: {} });
    out.push(r);
    prev = r.hash;
  }
  return out;
}

describe('receipt chain (RF-23 / RF-24)', () => {
  it('a clean chain verifies', () => {
    expect(verifyReceiptChain(chainOf(3))).toEqual([]);
  });
  it('editing one field breaks that link and the next', () => {
    const chain = chainOf(3);
    chain[1] = { ...chain[1]!, to: 'tampered' };
    const problems = verifyReceiptChain(chain);
    expect(problems.map((p) => p.seq)).toEqual([2]);
    expect(problems[0]!.message).toContain('hash');
  });
  it('a missing seq is reported', () => {
    const chain = chainOf(3).filter((r) => r.seq !== 2);
    expect(verifyReceiptChain(chain).some((p) => p.message.includes('seq'))).toBe(true);
  });
});

describe('audit chain (RF-25)', () => {
  const secret = 's3cret';
  function events(withSecret: string | undefined): AuditEvent[] {
    const e1 = sealEvent({ seq: 1, at: AT, kind: 'approval.decided', subject: { stage: 'check' }, actor: { name: 'Han', email: 'h@e.com' }, decision: 'approved', refs: [], prev: null }, withSecret);
    const e2 = sealEvent({ seq: 2, at: AT, kind: 'finding.answered', subject: { ledger: 'review-findings', entry: 'F-001', digest: 'd' }, actor: { name: 'Han', email: 'h@e.com' }, refs: [], prev: e1.hash }, withSecret);
    return [e1, e2];
  }
  it('verifies with and without a secret; no secret is only a hint', () => {
    expect(verifyAuditChain(events(secret), secret)).toEqual([]);
    const hint = verifyAuditChain(events(undefined), undefined);
    expect(hint.every((p) => p.severity === 'info')).toBe(true);
  });
  it('detects a forged hmac and a broken prev', () => {
    const es = events(secret);
    es[1] = { ...es[1]!, hmac: 'f'.repeat(64) };
    expect(verifyAuditChain(es, secret).some((p) => p.message.includes('hmac'))).toBe(true);
    const broken = events(undefined);
    broken[1] = { ...broken[1]!, prev: 'e'.repeat(64) };
    expect(verifyAuditChain(broken, undefined).some((p) => p.severity === 'blocking')).toBe(true);
  });
  it('round-trips through jsonl', () => {
    const es = events(undefined);
    expect(parseChain(es.map(serializeEvent).join(''))).toEqual(es);
  });
  it('matches a signature only on actor, kind, digest and entry', () => {
    const es = events(undefined);
    const entry = { id: 'F-001', signer: actorString({ name: 'Han', email: 'h@e.com' }) };
    expect(findSigningEvent(entry, es, 'finding.answered', 'd')).toBe(es[1]);
    expect(findSigningEvent(entry, es, 'finding.answered', 'other')).toBeUndefined();
    expect(findSigningEvent({ ...entry, signer: 'Han <other@e.com>' }, es, 'finding.answered', 'd')).toBeUndefined();
  });
});
