// design: cli §7.2 — CLI-26：solid 走查（含 CLI-13 署名不符被拒、RF-17 索引与基线同一事务）（规格开、接口开、一个需评审的包、章程答复、发现署名、两级审批、归档合并）。
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Project } from '../helpers/project.js';

const CHANGE = 'C-20260915-order-ledger';
const SIGNER = 'Test User <test@example.com>';
const AT = '2026-09-15T10:00:00Z';
const SHA = 'b'.repeat(64);

describe('solid walkthrough', () => {
  let p: Project;
  let execution = '';
  const c = (rel: string): string => `xforge/changes/${CHANGE}/${rel}`;

  beforeAll(async () => {
    p = await Project.create('solid');
    await p.write('package.json', '{"name":"orders","version":"0.0.0"}\n');
    await p.write('test.js', 'process.exit(0);\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'solid', '--platform', 'claude', '--platform', 'codex');
    // 人打开两条基线的治理，声明一个模块。
    const manifestPath = join(p.root, 'xforge', 'manifest.yaml');
    const manifest = parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['governance'] = { spec: true, interface: true };
    manifest['modules'] = [{ id: 'core', paths: ['src/core/**'] }];
    await p.write('xforge/manifest.yaml', (await import('yaml')).stringify(manifest));
    p.commit('init');
    await p.xforge('attest', 'verification', '--command', 'unit-tests=node test.js');
  });

  it('propose with both deltas', async () => {
    await p.write(c('change.yaml'), `id: ${CHANGE}\ntitle: 订单台账\nflow: solid\nrisk: medium\nimpact: [interface]\nbaseline_commit: ${p.head()}\n`);
    await p.write(c('proposal.md'), '# 订单台账\n\n## 背景\nb\n## 目标\ng\n## 非目标\nn\n## 为什么选这条流程\nmedium\n## 影响面\ninterface\n');
    await p.write(c('specs/orders/create.md'), '# 创建订单\n\n## ADDED\n### Requirement: REQ-orders-create-001 · 幂等创建\n- **WHEN** 同一幂等键重复提交\n- **THEN** 返回同一订单\n');
    await p.write(c('interfaces/order-core/api.md'), '# order-core\n\n## ADDED\n### Element: fn:createOrder · 创建订单\nsummary: (input: NewOrder) => Order\n');
    const s = await p.xforge('state', '--orient');
    const r = s.env.result as { orient: { invariants: { governance: { assurance: boolean }; enforcement: string } }; owed: Array<{ id: string; status: string }> };
    expect(r.orient.invariants.governance.assurance).toBe(true);
    expect(r.owed.find((o) => o.id === 'spec-delta')?.status).toBe('present');
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('design');
  });

  it('design: scope, mixed design with an alternative, plan; show slices a heading', async () => {
    await p.write(c('scope.yaml'), 'scheme: default\npaths: ["src/**", "test/**"]\n');
    await p.write(c('design.md'), [
      '# 设计', '', '## 技术路径', '内存台账 + 幂等键索引。', '## 集成点', 'HTTP 层。', '## 失败模式', '重复键冲突。', '## 迁移与回滚', '无状态。',
      '## 被否决的方案', '<!-- xforge:entries:begin kind=alternatives -->', '- 数据库唯一索引：需要数据库，超出本次范围。', '<!-- xforge:entries:end -->', '',
    ].join('\n'));
    await p.write(c('work-packages.yaml'), 'packages:\n  - id: P-01\n    title: 领域模型\n    depends_on: []\n    paths: ["src/core/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-1, text: "幂等键冲突返回同一订单"}]\n    review: required\n');
    await p.write(c('ledgers/exit/spec-conflicts.yaml'), 'kind: exit/spec-conflicts\nentries: []\n'); // design 站的出口条件：没矛盾就空（skills D15）
    const show = await p.xforge('show', 'doc:design.md#失败模式');
    expect(show.exit, JSON.stringify(show.env)).toBe(0);
    const sr = show.env.result as { content: string; complete: boolean; omitted: string[] };
    expect(sr.content).toContain('重复键冲突');
    expect(sr.complete).toBe(true);
    expect(sr.omitted).toEqual(['技术路径', '集成点', '迁移与回滚', '被否决的方案']);
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('check');
  });

  it('check: findings answered by a person, constitution replied, stage approved', async () => {
    await p.write(c('ledgers/review-findings.yaml'), `kind: review-findings\nconclusion: 覆盖了提案、规格、设计三份\nentries:\n  - id: F-001\n    conclusion: resolved\n    refs: [design.md#失败模式]\n    signer: "${SIGNER}"\n    at: ${AT}\n    note: 已补充\n`);
    await p.write(c('ledgers/constitution-reply.yaml'), 'kind: constitution-reply\nentries:\n  - id: 不做无测试的行为变更\n    conclusion: complies\n    refs: [REQ-orders-create-001]\n');
    const blockedBefore = await p.xforge('advance');
    expect(blockedBefore.exit).toBe(1);
    const tokens = ((blockedBefore.env.result as { blockers: Array<{ token: string }> }).blockers ?? []).map((b) => b.token);
    expect(tokens).toContain('attest-missing');
    expect(tokens).toContain('approval-missing');

    const forged = await p.xforge('attest', 'entry', 'review-findings', 'F-002');
    expect(forged.exit).toBe(1);
    const ans = await p.xforge('attest', 'finding', 'F-001');
    expect(ans.exit, JSON.stringify(ans.env)).toBe(0);
    const ap = await p.xforge('attest', 'approve', '--stage', 'check', '--decision', 'approved', '--note', 'ok');
    expect(ap.exit, JSON.stringify(ap.env)).toBe(0);
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('apply');
  });

  it('apply: a package marked review: required is integrated by its delivery', async () => {
    const d = await p.xforge('advance', 'package', 'P-01', '--dispatch');
    expect(d.exit, JSON.stringify(d.env)).toBe(0);
    execution = (d.env.result as { execution: string }).execution;
    expect((d.env.result as { package: { id: string; criteria: unknown[] } }).package).toMatchObject({ id: 'P-01' }); // 包简报不必再读计划
    await p.write('src/core/order.js', 'module.exports = { createOrder() { return {}; } };\n');
    expect((await p.xforge('run', '--package', 'P-01')).exit).toBe(0);
    await p.write(c('ledgers/deliveries/P-01.yaml'), `kind: delivery\nentries:\n  - id: ${execution}\n    package: P-01\n    baseline_commit: ${p.head()}\n    paths_changed: [src/core/order.js]\n    revision: ${SHA}\n    conclusion: succeeded\n    refs: [evidence/gates/unit-tests/1.yaml]\n    criteria: [{id: C-1, evidence: "test.js"}]\n    remaining: []\n    signer: ${execution}\n    at: ${AT}\n`);
    const delivered = await p.xforge('advance', 'package', 'P-01', '--deliver');
    expect(delivered.exit, JSON.stringify(delivered.env)).toBe(0);
    expect((delivered.env.result as { to: string }).to).toBe('integrated'); // 交付即集成；review: required 只是给审批人看的信息
    expect(((delivered.env.result as { blockers: Array<{ token: string }> }).blockers).map((b) => b.token)).not.toContain('package-pending:P-01'); // 登记之后本站还欠什么，一并回
    const shown = await p.xforge('show', 'package:P-01');
    expect((shown.env.result as { content: { state: string; paths: string[] } }).content).toMatchObject({ state: 'integrated', paths: ['src/core/**'] });
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('verify');
  });

  it('verify: assurance owed, receipt signed', async () => {
    await p.write(c('assurance.md'), '# 保证\n\n## 连贯性\n无分叉。\n## 覆盖\n<!-- xforge:entries:begin kind=coverage -->\n| REQ-orders-create-001 | test.js |\n<!-- xforge:entries:end -->\n');
    await p.write(c('ledgers/verification-receipt.yaml'), `kind: verification-receipt\nentries:\n  - id: unit-tests\n    conclusion: passed\n    refs: [evidence/gates/unit-tests/2.yaml]\n    signer: "${SIGNER}"\n    at: ${AT}\n`);
    expect((await p.xforge('attest', 'receipt')).exit).toBe(0);
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('ready-to-archive');
  });

  it('archive merges both baselines and rebuilds the indexes', async () => {
    expect((await p.xforge('attest', 'approve', '--archive', '--decision', 'approved')).exit).toBe(0);
    const ar = await p.xforge('advance', '--archive');
    expect(ar.exit, JSON.stringify(ar.env)).toBe(0);
    expect(ar.env.changed).toContain('xforge/specs/orders/create.md');
    expect(ar.env.changed).toContain('xforge/specs/orders/index.yaml');
    expect(ar.env.changed).toContain('xforge/interfaces/order-core/index.yaml');
    const domains = parse(await readFile(join(p.root, 'xforge', 'specs', 'index.yaml'), 'utf8')) as { domains: Array<{ id: string; capabilities: Array<{ id: string }> }> };
    expect(domains.domains).toEqual([{ id: 'orders', title: 'orders', capabilities: [{ id: 'create', path: 'orders/create.md' }] }]);
    const shown = await p.xforge('show', 'spec:REQ-orders-create-001', '--change', CHANGE);
    expect(shown.exit, JSON.stringify(shown.env)).toBe(0);
    expect((shown.env.result as { content: { title: string; body: string } }).content.title).toBe('幂等创建');
    const i = await p.xforge('inspect', '--change', CHANGE, '--hygiene');
    expect(i.exit, JSON.stringify(i.env)).toBe(0);
  });
});
