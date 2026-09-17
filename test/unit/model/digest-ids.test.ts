// design: rule-files §0 — D4 内容修订与 D10 id 形状。
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentRevision, ledgerDigest, recordHash } from '../../../src/model/digest.js';
import { ID, newChangeId, newExecutionId, receiptId, receiptSeq } from '../../../src/model/ids.js';

describe('contentRevision (D4)', () => {
  const a = { path: 'a.ts', bytes: 'x' };
  const b = { path: 'b.ts', bytes: 'y' };
  it('is independent of input order', () => {
    expect(contentRevision([a, b])).toBe(contentRevision([b, a]));
  });
  it('changes when a path or its bytes change', () => {
    expect(contentRevision([a, b])).not.toBe(contentRevision([{ ...a, bytes: 'z' }, b]));
    expect(contentRevision([a, b])).not.toBe(contentRevision([{ ...a, path: 'c.ts' }, b]));
  });
});

describe('canonical hashing', () => {
  it('ignores key order and undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
    expect(recordHash({ a: 1, hash: 'x' })).toBe(recordHash({ hash: 'y', a: 1 }));
  });
  it('ledger digest is the sha256 of the text (RF-22)', () => {
    expect(ledgerDigest('kind: delivery\n')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ids (D10)', () => {
  it('generates well-formed ids', () => {
    const date = new Date('2026-09-15T00:00:00Z');
    expect(newChangeId('Order Ledger', date)).toBe('C-20260915-order-ledger');
    expect(ID.execution.test(newExecutionId(date))).toBe(true);
    expect(receiptId(7)).toBe('R-0007');
    expect(receiptSeq('R-0007')).toBe(7);
  });
  it('rejects out-of-range receipt seq', () => {
    expect(() => receiptId(0)).toThrow();
  });
});
