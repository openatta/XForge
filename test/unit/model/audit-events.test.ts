// design: rule-files §5.3 — RF-35：scope: change 的站与终局审批的事件对每个方案可见；其余按方案过滤。
import { describe, expect, it } from 'vitest';
import { eventsFor } from '../../../src/audit/chain.js';
import type { AuditEvent } from '../../../src/model/types.js';

const ev = (n: number, scheme: string, subject: Record<string, unknown>): AuditEvent => ({ seq: n, at: '2026-09-17T00:00:00Z', kind: 'approval.decided', change: 'C-20260917-x', scheme, subject, actor: { name: 'a', email: 'a@x' }, decision: 'approved', refs: [], prev: null, hash: `h${n}`, hmac: null });

describe('eventsFor', () => {
  const chain = [ev(1, 'default', { stage: 'check', revision: 'r' }), ev(2, 'blackbox', { stage: 'check', revision: 'r' }), ev(3, 'default', { stage: 'clarify', revision: 'r' }), ev(4, 'blackbox', { archive: true, revision: 'r' })];
  it('RF-35 a scheme sees its own events, every scheme sees clarify and archive approvals', () => {
    const mine = eventsFor(chain, 'C-20260917-x', 'blackbox', { includeArchive: true, sharedStages: ['clarify'] }).map((e) => e.seq);
    expect(mine).toEqual([2, 3, 4]);
    const theirs = eventsFor(chain, 'C-20260917-x', 'default', { includeArchive: true, sharedStages: ['clarify'] }).map((e) => e.seq);
    expect(theirs).toEqual([1, 3, 4]);
  });
  it('without the sharing options only the scheme’s own events are returned', () => {
    expect(eventsFor(chain, 'C-20260917-x', 'blackbox').map((e) => e.seq)).toEqual([2, 4]);
  });
});
