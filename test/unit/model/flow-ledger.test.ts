// design: rule-files §3.1 §5.2 — RF-07、RF-09、`不欠不是待写`、RF-20、RF-21。
import { describe, expect, it } from 'vitest';
import { isIsolated, isOwed, openNeeds, validateFlow } from '../../../src/model/flow.js';
import { auditKindFor, requiresSignature, validateLedger } from '../../../src/model/ledger.js';
import type { Flow, Ledger } from '../../../src/model/types.js';

const flow: Flow = {
  name: 'solid', eligibility: { risk: ['low', 'medium'] },
  stages: [
    { id: 'propose', skill: 'xforge-propose', human: 'body', produces: [], ledgers: [], gates: ['structure'], exit: [{ kind: 'gate', ref: 'structure' }], rework_to: [] },
    { id: 'check', skill: 'xforge-check', human: 'tail', produces: [], ledgers: ['review-findings'], gates: ['ledgers'], exit: [{ kind: 'attested', ref: 'review-findings' }, { kind: 'approval', policy: 'stage' }], rework_to: ['propose'] },
  ],
  archive: { exit: [{ kind: 'approval', policy: 'final' }] },
  approval_policies: { stage: { min_approvers: 1, separation_of_duties: false }, final: { min_approvers: 1, separation_of_duties: true } },
};

describe('validateFlow (RF-07)', () => {
  it('accepts a well-formed flow', () => {
    expect(validateFlow(flow)).toEqual([]);
  });
  it('rejects rework to a later stage, an exit gate not declared, and an unknown policy', () => {
    const bad: Flow = {
      ...flow,
      stages: [
        { ...flow.stages[0]!, rework_to: ['check'], exit: [{ kind: 'gate', ref: 'unit-tests' }] },
        { ...flow.stages[1]!, exit: [{ kind: 'approval', policy: 'nope' }, { kind: 'ledger', ref: 'constitution-reply', requires: 'exists' }] },
      ],
    };
    const errors = validateFlow(bad);
    expect(errors.some((e) => e.includes('更早的站'))).toBe(true);
    expect(errors.some((e) => e.includes('unit-tests'))).toBe(true);
    expect(errors.some((e) => e.includes('nope'))).toBe(true);
    expect(errors.some((e) => e.includes('constitution-reply'))).toBe(true);
  });
  it('RF-09 skeleton without outline is an error', () => {
    const bad: Flow = { ...flow, stages: [{ ...flow.stages[0]!, produces: [{ id: 'p', path: 'p.md', side: 'spec', needs: [], read: 'skeleton' }] }, flow.stages[1]!] };
    expect(validateFlow(bad).some((e) => e.includes('outline'))).toBe(true);
  });
});

describe('owed vs not-owed', () => {
  it('assurance derives from either baseline switch', () => {
    expect([...openNeeds({ governance: { spec: false, interface: false } })]).toEqual([]);
    expect([...openNeeds({ governance: { spec: false, interface: true } })].sort()).toEqual(['assurance', 'interface']);
  });
  it('a spec-side output is owed only by the default scheme; a gated need closes it', () => {
    const open = openNeeds({ governance: { spec: true, interface: false } });
    expect(isOwed({ needs: ['spec'], side: 'spec' }, open, true)).toBe(true);
    expect(isOwed({ needs: ['spec'], side: 'spec' }, open, false)).toBe(false);
    expect(isOwed({ needs: ['interface'], side: 'spec' }, open, true)).toBe(false);
    expect(isOwed({ needs: [], side: 'impl' }, open, false)).toBe(true);
  });
  it('isolation follows the human point', () => {
    expect(isIsolated({ human: 'body' })).toBe(false);
    expect(isIsolated({ human: 'tail' })).toBe(true);
  });
});

describe('ledger signatures (RF-20 / RF-21)', () => {
  it('knows which conclusions need a person', () => {
    expect(requiresSignature('review-findings', { conclusion: 'open' })).toBe(false);
    expect(requiresSignature('review-findings', { conclusion: 'resolved' })).toBe(true);
    expect(requiresSignature('constitution-reply', { conclusion: 'complies' })).toBe(false);
    expect(requiresSignature('exit/material-questions', { conclusion: 'answered' })).toBe(true);
    expect(auditKindFor('exit/material-questions')).toBe('entry.decided');
    expect(auditKindFor('delivery')).toBeNull();
  });
  it('pairs signer with at and pins delivery signer to the execution id', () => {
    const ledger: Ledger = { kind: 'delivery', entries: [{ id: 'EX-20260915-a7k2q9', conclusion: 'succeeded', refs: [], signer: 'Han <h@e.com>', at: '2026-09-15T10:00:00Z' }] };
    expect(validateLedger(ledger).some((e) => e.includes('执行 id'))).toBe(true);
    const ok: Ledger = { kind: 'delivery', entries: [{ id: 'EX-20260915-a7k2q9', conclusion: 'succeeded', refs: [], signer: 'EX-20260915-a7k2q9', at: '2026-09-15T10:00:00Z' }] };
    expect(validateLedger(ok)).toEqual([]);
    const unpaired: Ledger = { kind: 'review-findings', entries: [{ id: 'F-001', conclusion: 'open', refs: [], at: '2026-09-15T10:00:00Z' }] };
    expect(validateLedger(unpaired).some((e) => e.includes('成对'))).toBe(true);
    // 缺署名不是形状错误：Agent 写台账时不知道谁来签。
    const unsigned: Ledger = { kind: 'verification-receipt', entries: [{ id: 'unit-tests', conclusion: 'passed', refs: [] }] };
    expect(validateLedger(unsigned)).toEqual([]);
  });
});
