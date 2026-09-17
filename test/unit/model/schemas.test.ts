// design: rule-files §1 — 每份 schema 一份合法样例、一份非法样例（迁移方案 S3 验收）。
import { describe, expect, it } from 'vitest';
import { SCHEMA_NAMES, validate, type SchemaName } from '../../../src/model/schemas.js';

const SHA = 'a'.repeat(64);
const AT = '2026-09-15T10:00:00Z';

const samples: Record<SchemaName, { valid: unknown; invalid: unknown }> = {
  manifest: {
    valid: {
      version: 1, scaffold: { version: '1.0.0-alpha.1' }, governance: { spec: true, interface: false },
      flow: { default: 'solid' }, modules: [{ id: 'core', paths: ['src/core/**'] }], platforms: ['claude'],
      language: 'zh-CN', verification: { commands: { 'unit-tests': 'npm test' } },
      selected: { flows: ['quick', 'solid'], gates: ['structure'], policies: ['protected-governance'] },
    },
    // RF-04：未知顶层键被拒
    invalid: {
      version: 1, scaffold: { version: '1' }, governance: { spec: true, interface: false }, flow: { default: 'solid' },
      modules: [], platforms: [], language: 'zh-CN', selected: { flows: [], gates: [], policies: [] }, unknown: true,
    },
  },
  flow: {
    valid: {
      name: 'quick', eligibility: { risk: ['low'] },
      stages: [{ id: 'propose', skill: 'xforge-propose', human: 'body', produces: [{ id: 'proposal', path: 'proposal.md', side: 'spec', needs: [], read: 'skeleton', outline: ['背景'] }], ledgers: [], gates: ['structure'], exit: [{ kind: 'gate', ref: 'structure' }], rework_to: [] }],
      archive: { exit: [{ kind: 'approval', policy: 'final' }] },
      approval_policies: { final: { min_approvers: 1, separation_of_duties: true } },
    },
    // RF-09：mixed 没有 markers
    invalid: {
      name: 'quick', eligibility: { risk: ['low'] },
      stages: [{ id: 'design', skill: 'xforge-design', human: 'none', produces: [{ id: 'design', path: 'design.md', side: 'impl', needs: [], read: 'mixed', outline: ['技术路径'] }], ledgers: [], gates: [], exit: [], rework_to: [] }],
      archive: { exit: [] }, approval_policies: {},
    },
  },
  gate: {
    valid: { name: 'unit-tests', kind: 'command', command: { from: 'manifest' }, inputs: ['src/**'], timeout_seconds: 600 },
    invalid: { name: 'unit-tests', kind: 'command', inputs: ['src/**'] },
  },
  policy: {
    valid: { name: 'protected-governance', rules: [{ effect: 'deny', tools: ['write'], paths: ['xforge/.audit/**'] }] },
    // RF-13：paths 与 commands 至少一项
    invalid: { name: 'p', rules: [{ effect: 'deny', tools: ['write'] }] },
  },
  hook: { valid: { name: 'enforce', events: ['pre-tool-use'], command: 'xforge-enforce --host claude' }, invalid: { name: 'enforce', events: [], command: 'x' } },
  executor: { valid: { name: 'xforge-executor', description: 'd', tools: ['read', 'write'], prompt_file: 'p.md' }, invalid: { name: 'xforge-executor', tools: [] } },
  integrity: { valid: { scaffold_version: '1', files: { 'flows/solid.yaml': `sha256:${SHA}` } }, invalid: { scaffold_version: '1', files: { 'a': 'md5:1' } } },
  'baseline-domains': { valid: { domains: [{ id: 'auth', title: '认证', capabilities: [{ id: 'login', path: 'auth/login.md' }] }] }, invalid: { domains: [{ id: 'Auth', title: 't', capabilities: [] }] } },
  'baseline-entries': { valid: { entries: [{ id: 'REQ-auth-login-001', capability: 'login', title: 't' }] }, invalid: { entries: [{ id: 'x' }] } },
  change: {
    valid: { id: 'C-20260915-order-ledger', title: '订单台账', flow: 'solid', risk: 'medium', impact: ['interface'], baseline_commit: '3f9c1a2' },
    invalid: { id: 'order-ledger', title: 't', flow: 'solid', risk: 'medium', impact: [], baseline_commit: 'zzz' },
  },
  scope: { valid: { scheme: 'default', paths: ['src/**'] }, invalid: { scheme: 'default', paths: [] } },
  'work-packages': {
    valid: { packages: [{ id: 'P-01', title: '领域模型', depends_on: [], paths: ['src/core/**'], verify: { gate: 'unit-tests' }, criteria: [{ id: 'C-1', text: '幂等' }], review: 'none' }] },
    invalid: { packages: [{ id: 'P1', title: 't', depends_on: [], paths: [], verify: { gate: 'g' }, criteria: [], review: 'none' }] },
  },
  ledger: {
    valid: { kind: 'review-findings', entries: [{ id: 'F-001', conclusion: 'resolved', refs: ['design.md#技术路径'], signer: 'Han Shan <han@example.com>', at: AT }] },
    // RF-20：结论不在该种类的枚举里
    invalid: { kind: 'review-findings', entries: [{ id: 'F-001', conclusion: 'done', refs: [] }] },
  },
  'gate-run': {
    valid: { gate: 'structure', run: 1, at: AT, revision: SHA, result: 'passed', accepted: [{ ledger: 'review-findings', digest: SHA, verdict: 'accepted' }] },
    invalid: { gate: 'structure', run: 0, at: AT, revision: SHA, result: 'maybe' },
  },
  receipt: {
    valid: { id: 'R-0001', seq: 1, kind: 'stage-transition', at: AT, change: 'C-20260915-x', scheme: 'default', prev: null, from: 'propose', to: 'apply', subject: { stage: 'propose' }, hash: SHA },
    invalid: { id: 'R-1', seq: 1, kind: 'stage-transition', at: AT, change: 'C-20260915-x', scheme: 'default', prev: null, from: 'a', to: 'b', subject: {}, hash: SHA },
  },
  projection: {
    valid: { execution: 'EX-20260915-a7k2q9', kind: 'package', change: 'C-20260915-x', scheme: 'default', stage: 'apply', package: 'P-01', workdir: '/w', opened_by: 'R-0002', closed_by: null, allow: ['src/**'] },
    // kind=package 必须给 package
    invalid: { execution: 'EX-20260915-a7k2q9', kind: 'package', change: 'C-20260915-x', scheme: 'default', stage: 'apply', workdir: '/w', opened_by: 'R-0002', closed_by: null, allow: [] },
  },
  'audit-event': {
    valid: { seq: 1, at: AT, kind: 'approval.decided', change: 'C-20260915-x', scheme: 'default', subject: { stage: 'check' }, actor: { name: 'Han', email: 'h@e.com' }, decision: 'approved', refs: [], prev: null, hash: SHA, hmac: null },
    invalid: { seq: 1, at: AT, kind: 'approval.decided', subject: {}, actor: { name: '' }, refs: [], prev: null, hash: SHA, hmac: null },
  },
  'audit-index': { valid: { events: [{ hash: SHA, kind: 'approval.decided', at: AT }] }, invalid: { events: [{ hash: 'x' }] } },
  diagnostic: {
    valid: { code: 'XF-RUN-001', title: 't', meaning: 'm', remedy: { command: 'xforge run', text: 't' }, variants: [] },
    // RF-28：remedy.command 必须是本 CLI 的调用
    invalid: { code: 'XF-RUN-001', title: 't', meaning: 'm', remedy: { command: 'rm -rf /', text: 't' }, variants: [] },
  },
  'upgrade-status': {
    valid: { from: '1.0.0-alpha.1', to: '1.0.0-alpha.2', started_at: AT, classified: { 'flows/solid.yaml': 'unchanged', 'skills/xforge/SKILL_cn.md': 'modified' }, pending: ['skills/xforge/SKILL_cn.md'] },
    invalid: { from: '1', to: '2', started_at: AT, classified: { 'a': 'weird' }, pending: [] },
  },
  'mcp-approval': {
    valid: { approver: 'review-bot', decision: 'approved', note: 'ok' },
    invalid: { approver: '', decision: 'maybe' },
  },
  envelope: {
    valid: { ok: false, verb: 'advance', result: {}, diagnostics: [{ code: 'XF-ADVANCE-001', severity: 'blocking', message: 'm' }], changed: [], next: [{ command: 'xforge state', why: 'w' }] },
    invalid: { ok: true, verb: 'state', result: {}, diagnostics: [], changed: [], next: [{ command: 'a', why: 'b' }, { command: 'a', why: 'b' }, { command: 'a', why: 'b' }, { command: 'a', why: 'b' }] },
  },
};

describe('a delivery record needs no revision (the receipt carries it)', () => {
  it('validates without revision and rejects a missing package', () => {
    const base = { id: 'EX-20260915-a7k2q9', package: 'P-01', baseline_commit: '3f9c1a2', paths_changed: ['src/a.ts'], conclusion: 'succeeded', refs: [], criteria: [], remaining: [], signer: 'EX-20260915-a7k2q9', at: AT };
    expect(validate('ledger', { kind: 'delivery', entries: [base] })).toEqual({ ok: true });
    const { package: _p, ...noPackage } = base;
    expect(validate('ledger', { kind: 'delivery', entries: [noPackage] }).ok).toBe(false);
  });
});

describe('schemas', () => {
  for (const name of SCHEMA_NAMES) {
    it(`${name}: accepts the valid sample and rejects the invalid one`, () => {
      expect(validate(name, samples[name].valid)).toEqual({ ok: true });
      expect(validate(name, samples[name].invalid).ok).toBe(false);
    });
  }
});
