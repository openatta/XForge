// design: cli §1 D3、rule-files §6 RF-27 — 每个诊断码走到它的那条路：这里把字典里此前没有任何测试点名的码逐个触发，验退出码分流与补救。
// 覆盖：XF-ADVANCE-003/004/005/006/008/009、XF-ATTEST-001（署名不符、职责分离）、XF-INSPECT-002/005/007/008/009/010、XF-MODEL-001/002、XF-RUN-002/003/004，
// 以及无归属改动的 blocker（unclaimed:<path>，它不是诊断码）。
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { Project, repoRoot, type Result } from '../helpers/project.js';

const CHANGE = 'C-20260915-diag';
const SIGNER = 'Test User <test@example.com>';
const AT = '2026-09-15T10:00:00Z';
const SHA = 'c'.repeat(64);
const code = (r: Result): string | undefined => r.env.diagnostics[0]?.code;
const codes = (r: Result): string[] => r.env.diagnostics.map((d) => d.code);
const blockers = (r: Result): string[] => ((r.env.result as { blockers?: Array<{ token: string }> }).blockers ?? []).map((b) => b.token);

const PLAN = (extra = ''): string =>
  'packages:\n' +
  '  - id: P-01\n    title: core\n    depends_on: []\n    paths: ["src/core/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-1, text: "core works"}]\n    review: none\n' +
  '  - id: P-02\n    title: api\n    depends_on: [P-01]\n    paths: ["src/api/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-2, text: "api works"}]\n    review: none\n' +
  extra;

describe('diagnostic paths on a solid change', () => {
  let p: Project;
  let execution = '';
  const c = (rel: string): string => `xforge/changes/${CHANGE}/${rel}`;
  const abs = (rel: string): string => join(p.root, c(rel));
  const gateRuns = (gate: string): string[] => readdirSync(abs(`evidence/gates/${gate}`)).filter((f) => f.endsWith('.yaml')).sort();

  beforeAll(async () => {
    p = await Project.create('diag');
    await p.write('package.json', '{"name":"diag","version":"0.0.0"}\n');
    await p.write('test.js', 'process.exit(0);\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'solid', '--platform', 'claude');
    p.commit('init');
    await p.xforge('attest', 'verification', '--command', 'unit-tests=node test.js');
    await p.write(c('change.yaml'), `id: ${CHANGE}\ntitle: diag\nflow: solid\nrisk: low\nimpact: []\nbaseline_commit: ${p.head()}\n`);
    await p.write(c('proposal.md'), '# diag\n\n## 背景\nb\n## 目标\ng\n## 非目标\nn\n## 为什么选这条流程\nlow\n## 影响面\nnone\n');
  });

  it('XF-MODEL-002 a declaration naming a flow the manifest did not select is unreadable governance (exit 3)', async () => {
    await p.write('xforge/changes/C-20260915-badflow/change.yaml', `id: C-20260915-badflow\ntitle: x\nflow: bogus\nrisk: low\nimpact: []\nbaseline_commit: ${p.head()}\n`);
    const r = await p.xforge('state', '--change', 'C-20260915-badflow');
    expect(r.exit).toBe(3);
    expect(code(r)).toBe('XF-MODEL-002');
    rmSync(join(p.root, 'xforge', 'changes', 'C-20260915-badflow'), { recursive: true });
  });

  it('XF-ADVANCE-003 advance --no-run refuses a stale gate record; a plain advance reruns it', async () => {
    expect((await p.xforge('run')).exit).toBe(0);
    await p.write(c('proposal.md'), '# diag\n\n## 背景\nb2\n## 目标\ng\n## 非目标\nn\n## 为什么选这条流程\nlow\n## 影响面\nnone\n');
    const stale = await p.xforge('advance', '--no-run');
    expect(stale.exit).toBe(1);
    expect(code(stale)).toBe('XF-ADVANCE-003');
    expect(stale.env.diagnostics[0]?.remedy?.command).toMatch(/^xforge run --gate /);
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('design');
  });

  it('design writes scope, design and a two-package plan, then leaves for check', async () => {
    await p.write(c('scope.yaml'), 'scheme: default\npaths: ["src/**"]\n');
    await p.write(c('design.md'), ['# 设计', '', '## 技术路径', 'a', '## 集成点', 'b', '## 失败模式', 'c', '## 迁移与回滚', 'd', '## 被否决的方案', '<!-- xforge:entries:begin kind=alternatives -->', '- e', '<!-- xforge:entries:end -->', ''].join('\n'));
    await p.write(c('work-packages.yaml'), PLAN());
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('check');
  });

  it('XF-ATTEST-001 a ledger entry signed by someone other than the git identity cannot be attested', async () => {
    await p.write(c('ledgers/review-findings.yaml'), `kind: review-findings\nconclusion: ok\nentries:\n  - id: F-001\n    conclusion: resolved\n    refs: [design.md#失败模式]\n    signer: "Someone Else <else@example.com>"\n    at: ${AT}\n`);
    const forged = await p.xforge('attest', 'finding', 'F-001');
    expect(forged.exit).toBe(1);
    expect(code(forged)).toBe('XF-ATTEST-001');
    expect(forged.env.diagnostics[0]?.message).toContain('Someone Else');
    await p.write(c('ledgers/review-findings.yaml'), `kind: review-findings\nconclusion: ok\nentries:\n  - id: F-001\n    conclusion: resolved\n    refs: [design.md#失败模式]\n    signer: "${SIGNER}"\n    at: ${AT}\n`);
    expect((await p.xforge('attest', 'finding', 'F-001')).exit).toBe(0);
  });

  it('XF-RUN-004 the ledgers gate rejects a ledger whose kind does not match the slot', async () => {
    await p.write(c('ledgers/constitution-reply.yaml'), 'kind: review-findings\nentries:\n  - id: 不做无测试的行为变更\n    conclusion: complies\n    refs: [design.md]\n');
    const r = await p.xforge('run', '--gate', 'ledgers');
    expect(r.exit).toBe(1);
    expect(codes(r)).toContain('XF-RUN-004');
    expect(r.env.diagnostics.find((d) => d.code === 'XF-RUN-004')?.message).toContain('constitution-reply');
    await p.write(c('ledgers/constitution-reply.yaml'), 'kind: constitution-reply\nentries:\n  - id: 不做无测试的行为变更\n    conclusion: complies\n    refs: [design.md]\n');
    expect((await p.xforge('run', '--gate', 'ledgers')).exit).toBe(0);
    expect((await p.xforge('attest', 'approve', '--stage', 'check', '--decision', 'approved')).exit).toBe(0);
    // CLI-33 审批绑修订：批完再改本站产出，审批作废，要重批。
    await p.write(c('design.md'), ['# 设计', '', '## 技术路径', 'a（批后改动）', '## 集成点', 'b', '## 失败模式', 'c', '## 迁移与回滚', 'd', '## 被否决的方案', '<!-- xforge:entries:begin kind=alternatives -->', '- e', '<!-- xforge:entries:end -->', ''].join('\n'));
    expect(blockers(await p.xforge('state'))).toContain('approval-stale');
    const stale = await p.xforge('advance');
    expect(stale.exit).toBe(1);
    expect(blockers(stale)).toContain('approval-stale');
    expect((await p.xforge('attest', 'approve', '--stage', 'check', '--decision', 'approved')).exit).toBe(0);
    expect(blockers(await p.xforge('state'))).not.toContain('approval-stale');
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('apply');
  });

  it('XF-ADVANCE-004 a package cannot be dispatched before the packages it depends on are integrated', async () => {
    const r = await p.xforge('advance', 'package', 'P-02', '--dispatch');
    expect(r.exit).toBe(1);
    expect(code(r)).toBe('XF-ADVANCE-004');
    expect(r.env.diagnostics[0]?.message).toContain('P-01');
  });

  it('XF-ADVANCE-006 a package whose paths fall outside the scope cannot be dispatched', async () => {
    await p.write(c('work-packages.yaml'), PLAN('  - id: P-03\n    title: docs\n    depends_on: []\n    paths: ["docs/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-3, text: "x"}]\n    review: none\n'));
    const r = await p.xforge('advance', 'package', 'P-03', '--dispatch');
    expect(r.exit).toBe(1);
    expect(code(r)).toBe('XF-ADVANCE-006');
    expect(r.env.diagnostics[0]?.message).toContain('docs/**');
    await p.write(c('work-packages.yaml'), PLAN());
  });

  it('unclaimed:<path> a change in the scope that no package claims blocks the stage exit', async () => {
    await p.write('src/stray.js', '// nobody claims me\n');
    const s = await p.xforge('state');
    expect(blockers(s)).toContain('unclaimed:src/stray.js');
    rmSync(join(p.root, 'src', 'stray.js'));
    expect(blockers(await p.xforge('state'))).not.toContain('unclaimed:src/stray.js');
  });

  it('XF-RUN-002 a gate that exceeds its timeout is recorded as failed and reported as a timeout', async () => {
    const d = await p.xforge('advance', 'package', 'P-01', '--dispatch');
    expect(d.exit, JSON.stringify(d.env)).toBe(0);
    execution = (d.env.result as { execution: string }).execution;
    await p.write('src/core/a.js', 'module.exports = 1;\n');
    const gatePath = join(p.root, 'xforge', 'scaffold', 'gates', 'unit-tests.yaml');
    const original = readFileSync(gatePath, 'utf8');
    writeFileSync(gatePath, original.replace(/timeout_seconds: \d+/, 'timeout_seconds: 1'));
    await p.write('test.js', 'setTimeout(() => process.exit(0), 4000);\n');
    const r = await p.xforge('run', '--package', 'P-01');
    expect(r.exit).toBe(1);
    expect(codes(r)).toContain('XF-RUN-002');
    writeFileSync(gatePath, original);
  });

  it('XF-RUN-003 a failing gate command is a blocking diagnostic with the log tail', async () => {
    await p.write('test.js', 'console.log("boom"); process.exit(1);\n');
    const r = await p.xforge('run', '--package', 'P-01');
    expect(r.exit).toBe(1);
    expect(codes(r)).toContain('XF-RUN-003');
    expect(r.env.diagnostics.find((d) => d.code === 'XF-RUN-003')?.remedy?.command).toMatch(/^xforge show gate:unit-tests/);
    await p.write('test.js', 'process.exit(0);\n');
    expect((await p.xforge('run', '--package', 'P-01')).exit).toBe(0);
  });

  it('XF-MODEL-001 / XF-ADVANCE-005 / XF-ADVANCE-009 a delivery record is checked for shape, signer and the working tree', async () => {
    const entry = (signer: string, paths: string): string => `kind: delivery\nentries:\n  - id: ${execution}\n    package: P-01\n    baseline_commit: ${p.head()}\n    paths_changed: ${paths}\n    revision: ${SHA}\n    conclusion: succeeded\n    refs: [evidence/gates/unit-tests/${gateRuns('unit-tests').at(-1)}]\n    criteria: [{id: C-1, evidence: "test.js"}]\n    remaining: []\n    signer: ${signer}\n    at: ${AT}\n`;
    await p.write(c('ledgers/deliveries/P-01.yaml'), 'kind: delivery\nentries: 5\n');
    const shape = await p.xforge('advance', 'package', 'P-01', '--deliver');
    expect(shape.exit).toBe(1);
    expect(code(shape)).toBe('XF-MODEL-001');
    await p.write(c('ledgers/deliveries/P-01.yaml'), entry('nobody', '[src/core/a.js]'));
    const signer = await p.xforge('advance', 'package', 'P-01', '--deliver');
    expect(signer.exit).toBe(1);
    expect(code(signer)).toBe('XF-ADVANCE-005');
    await p.write(c('ledgers/deliveries/P-01.yaml'), entry(execution, '[]'));
    const tree = await p.xforge('advance', 'package', 'P-01', '--deliver');
    expect(tree.exit).toBe(1);
    expect(code(tree)).toBe('XF-ADVANCE-009');
    expect(tree.env.diagnostics[0]?.message).toContain('src/core/a.js');
    await p.write(c('ledgers/deliveries/P-01.yaml'), entry(execution, '[src/core/a.js]'));
    const ok = await p.xforge('advance', 'package', 'P-01', '--deliver');
    expect(ok.exit, JSON.stringify(ok.env)).toBe(0);
    expect((ok.env.result as { to: string }).to).toBe('integrated');
  });

  it('the second package goes through once its dependency is integrated; the stage leaves for verify', async () => {
    const d = await p.xforge('advance', 'package', 'P-02', '--dispatch');
    expect(d.exit, JSON.stringify(d.env)).toBe(0);
    const ex2 = (d.env.result as { execution: string }).execution;
    await p.write('src/api/b.js', 'module.exports = 2;\n');
    expect((await p.xforge('run', '--package', 'P-02')).exit).toBe(0);
    await p.write(c('ledgers/deliveries/P-02.yaml'), `kind: delivery\nentries:\n  - id: ${ex2}\n    package: P-02\n    baseline_commit: ${p.head()}\n    paths_changed: [src/api/b.js]\n    revision: ${SHA}\n    conclusion: succeeded\n    refs: [evidence/gates/unit-tests/${gateRuns('unit-tests').at(-1)}]\n    criteria: [{id: C-2, evidence: "test.js"}]\n    remaining: []\n    signer: ${ex2}\n    at: ${AT}\n`);
    expect((await p.xforge('advance', 'package', 'P-02', '--deliver')).exit).toBe(0);
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('verify');
  });

  it('XF-INSPECT-002 a ledger file that is not a ledger is corruption (exit 3)', async () => {
    await p.write(c('ledgers/bogus.yaml'), 'kind: review-findings\nentries: 5\n');
    const r = await p.xforge('inspect');
    expect(r.exit).toBe(3);
    expect(codes(r)).toContain('XF-INSPECT-002');
    rmSync(abs('ledgers/bogus.yaml'));
  });

  it('XF-INSPECT-007 a ledger entry that references a file that does not exist', async () => {
    await p.write(c('ledgers/verification-receipt.yaml'), `kind: verification-receipt\nentries:\n  - id: unit-tests\n    conclusion: passed\n    refs: [evidence/gates/nope/9.yaml]\n`);
    const r = await p.xforge('inspect');
    expect(r.exit).toBe(3);
    expect(codes(r)).toContain('XF-INSPECT-007');
    rmSync(abs('ledgers/verification-receipt.yaml'));
  });

  it('XF-INSPECT-008 a projection whose opening receipt is not on the chain', async () => {
    const path = abs('evidence/projections/EX-20260915-zzzzzz.yaml');
    writeFileSync(path, stringify({ execution: 'EX-20260915-zzzzzz', kind: 'stage', change: CHANGE, scheme: 'default', stage: 'verify', workdir: p.root, opened_by: 'R-9999', closed_by: null, allow: ['src/**'] }));
    const r = await p.xforge('inspect');
    expect(r.exit).toBe(3);
    expect(codes(r)).toContain('XF-INSPECT-008');
    expect(r.env.diagnostics.find((d) => d.code === 'XF-INSPECT-008')?.message).toContain('R-9999');
    rmSync(path);
  });

  it('XF-INSPECT-005 a baseline group without an entry index, or whose index disagrees with the files', async () => {
    mkdirSync(join(p.root, 'xforge', 'specs', 'ghost'), { recursive: true });
    await p.write('xforge/specs/ghost/x.md', '# x\n\n<!-- xforge:entries:begin kind=requirements -->\n### Requirement: REQ-ghost-x-001 · a\n- **WHEN** a\n<!-- xforge:entries:end -->\n');
    const noIndex = await p.xforge('inspect');
    expect(noIndex.exit).toBe(3);
    expect(noIndex.env.diagnostics.find((d) => d.code === 'XF-INSPECT-005')?.message).toContain('没有条目层索引');
    await p.write('xforge/specs/ghost/index.yaml', 'entries:\n  - {id: REQ-ghost-x-002, capability: x, title: b}\n');
    const disagree = await p.xforge('inspect');
    expect(disagree.exit).toBe(3);
    const messages = disagree.env.diagnostics.filter((d) => d.code === 'XF-INSPECT-005').map((d) => d.message);
    expect(messages.some((m) => m.includes('索引有 REQ-ghost-x-002'))).toBe(true);
    expect(messages.some((m) => m.includes('文件有 REQ-ghost-x-001'))).toBe(true);
    rmSync(join(p.root, 'xforge', 'specs', 'ghost'), { recursive: true });
    expect((await p.xforge('inspect')).exit).toBe(0);
  });

  it('XF-INSPECT-010 a station Skill that lost its four sections is a warning, not corruption', async () => {
    const skill = join(p.root, 'xforge', 'scaffold', 'skills', 'xforge-verify', 'SKILL.md');
    const original = readFileSync(skill, 'utf8');
    writeFileSync(skill, '---\nname: xforge-verify\n---\n\n# x\n\n## 判断\nonly one\n');
    const r = await p.xforge('inspect');
    expect(r.exit).toBe(0);
    const d = r.env.diagnostics.find((x) => x.code === 'XF-INSPECT-010');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('xforge-verify');
    rmSync(skill);
    expect((await p.xforge('inspect')).env.diagnostics.find((x) => x.code === 'XF-INSPECT-010')?.message).toContain('缺 en 文件');
    writeFileSync(skill, original);
  });

  it('XF-INSPECT-009 hygiene: a selected gate no flow uses, a Skill no flow names, a managed file edited outside its local zone', async () => {
    const manifestPath = join(p.root, 'xforge', 'manifest.yaml');
    const manifestText = readFileSync(manifestPath, 'utf8');
    const manifest = parse(manifestText) as { selected: { gates: string[] } };
    manifest.selected.gates.push('ghost-gate');
    writeFileSync(manifestPath, stringify(manifest));
    mkdirSync(join(p.root, 'xforge', 'scaffold', 'skills', 'xforge-extra'), { recursive: true });
    copyFileSync(join(repoRoot, 'scaffold', 'skills', 'xforge-verify', 'SKILL_cn.md'), join(p.root, 'xforge', 'scaffold', 'skills', 'xforge-extra', 'SKILL_cn.md'));
    const gatePath = join(p.root, 'xforge', 'scaffold', 'gates', 'structure.yaml');
    const gateText = readFileSync(gatePath, 'utf8');
    writeFileSync(gatePath, gateText + '# edited outside any local zone\n');
    const quiet = await p.xforge('inspect');
    expect(quiet.env.diagnostics.filter((d) => d.code === 'XF-INSPECT-009')).toEqual([]);
    const r = await p.xforge('inspect', '--hygiene');
    expect(r.exit).toBe(0);
    const messages = r.env.diagnostics.filter((d) => d.code === 'XF-INSPECT-009').map((d) => d.message);
    expect(messages.some((m) => m.includes('ghost-gate'))).toBe(true);
    expect(messages.some((m) => m.includes('xforge-extra'))).toBe(true);
    expect(messages.some((m) => m.includes('gates/structure.yaml'))).toBe(true);
    writeFileSync(manifestPath, manifestText);
    rmSync(join(p.root, 'xforge', 'scaffold', 'skills', 'xforge-extra'), { recursive: true });
    writeFileSync(gatePath, gateText);
  });

  it('XF-ADVANCE-008 the archive refuses while the hygiene pass reports corruption', async () => {
    const receipt = `kind: verification-receipt\nentries:\n  - id: unit-tests\n    conclusion: passed\n    refs: [evidence/gates/unit-tests/${gateRuns('unit-tests').at(-1)}]\n    signer: "${SIGNER}"\n    at: ${AT}\n`;
    await p.write(c('ledgers/verification-receipt.yaml'), receipt);
    expect((await p.xforge('attest', 'receipt')).exit).toBe(0);
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('ready-to-archive');
    await p.write(c('ledgers/bogus.yaml'), 'kind: review-findings\nentries: 5\n');
    const r = await p.xforge('advance', '--archive');
    expect(r.exit).toBe(1);
    expect(code(r)).toBe('XF-ADVANCE-008');
    expect(r.env.diagnostics[0]?.message).toContain('XF-INSPECT-002');
    expect(r.env.diagnostics[0]?.remedy?.command).toBe('xforge inspect --hygiene');
    rmSync(abs('ledgers/bogus.yaml'));
  });

  it('XF-ATTEST-001 separation of duties: whoever committed inside the scope cannot give the final approval', async () => {
    p.commit('implementation by the same person');
    const r = await p.xforge('attest', 'approve', '--archive', '--decision', 'approved');
    expect(r.exit).toBe(1);
    expect(code(r)).toBe('XF-ATTEST-001');
    expect(r.env.diagnostics[0]?.message).toContain('separation_of_duties');
    execFileSync('git', ['config', 'user.name', 'Reviewer'], { cwd: p.root });
    execFileSync('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: p.root });
    expect((await p.xforge('attest', 'approve', '--archive', '--decision', 'approved')).exit).toBe(0);
    const done = await p.xforge('advance', '--archive');
    expect(done.exit, JSON.stringify(done.env)).toBe(0);
    expect((done.env.result as { to: string }).to).toBe('archived');
  });
});
