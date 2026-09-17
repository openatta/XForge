// design: cli §7.1 — CLI-26：quick 走查逐行复现（规格关、接口关、默认方案、一个包）；顺带证明 CLI-11、CLI-15、CLI-22、RF-05。
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Project } from '../helpers/project.js';

const CHANGE = 'C-20260915-greeter';
const SIGNER = 'Test User <test@example.com>';
const AT = '2026-09-15T10:00:00Z';

describe('quick walkthrough', () => {
  let p: Project;
  let execution = '';

  beforeAll(async () => {
    p = await Project.create('quick');
    await p.write('package.json', '{"name":"greeter","version":"0.0.0"}\n');
    await p.write('test.js', 'process.exit(0);\n');
    p.commit('seed');
  });

  it('init creates the governance tree and projects claude', async () => {
    const r = await p.xforge('init', '--flow', 'quick', '--platform', 'claude');
    expect(r.exit, r.stderr).toBe(0);
    expect(r.env.changed).toContain('xforge/manifest.yaml');
    expect(r.env.changed).toContain('.claude/skills/xforge/SKILL.md');
    const settings = JSON.parse(await readFile(join(p.root, '.claude', 'settings.json'), 'utf8')) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toBe('xforge-enforce --host claude');
    const again = await p.xforge('sync');
    expect(again.env.changed).toEqual([]);
    p.commit('init');
  });

  it('a person declares the verification command', async () => {
    const r = await p.xforge('attest', 'verification', '--command', 'unit-tests=node test.js');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(r.env.changed).toEqual(['xforge/.audit/chain.jsonl', 'xforge/manifest.yaml']);
  });

  it('state with no change drafts the declaration', async () => {
    const r = await p.xforge('state');
    expect(r.exit).toBe(0);
    const result = r.env.result as { position: { status: string }; drafts: Record<string, string> };
    expect(result.position.status).toBe('no-change');
    expect(result.drafts['change']).toContain('flow: quick');
  });

  it('propose: declaration, proposal, scope and plan; then advance', async () => {
    await p.write(`xforge/changes/${CHANGE}/change.yaml`, `id: ${CHANGE}\ntitle: greeter\nflow: quick\nrisk: low\nimpact: []\nbaseline_commit: ${p.head()}\n`);
    await p.write(`xforge/changes/${CHANGE}/proposal.md`, '# greeter\n\n## 背景\nx\n## 目标\ny\n## 非目标\nz\n## 为什么选这条流程\nlow\n## 影响面\nnone\n');
    await p.write(`xforge/changes/${CHANGE}/scope.yaml`, 'scheme: default\npaths: ["src/**"]\n');
    await p.write(`xforge/changes/${CHANGE}/work-packages.yaml`, 'packages:\n  - id: P-01\n    title: greeter\n    depends_on: []\n    paths: ["src/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-1, text: "greet returns hello"}]\n    review: none\n');
    const s = await p.xforge('state', '--orient');
    expect(s.exit, JSON.stringify(s.env)).toBe(0);
    const result = s.env.result as { orient: { invariants: { enforcement: string }; stage: { id: string; complete: boolean } }; owed: Array<{ id: string; status: string }>; blockers: unknown[] };
    expect(Object.keys(result)[0]).toBe('orient');
    expect(result.orient.stage.id).toBe('propose');
    expect(result.orient.stage.complete).toBe(true);
    expect(result.owed.find((o) => o.id === 'spec-delta')?.status).toBe('not-owed');
    // 门还没跑：被挡着是正常状态，不是故障。
    expect(result.blockers).toEqual([expect.objectContaining({ token: 'gate-missing', ref: 'structure', verb: 'run' })]);
    const twice = await p.xforge('state', '--orient');
    expect(JSON.stringify(twice.env)).toBe(JSON.stringify(s.env));

    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    const ar = a.env.result as { receipt: string; to: string; stage: { id: string } };
    expect(ar.receipt).toBe('R-0001');
    expect(ar.to).toBe('apply');
    expect(ar.stage.id).toBe('apply');
    expect(a.env.changed).toContain(`xforge/changes/${CHANGE}/evidence/receipts/0001-stage-transition.yaml`);
  });

  it('apply: dispatch, deliver (= integrate), advance', async () => {
    const d = await p.xforge('advance', 'package', 'P-01', '--dispatch');
    expect(d.exit, JSON.stringify(d.env)).toBe(0);
    const dr = d.env.result as { receipt: string; execution: string; draft: string };
    expect(dr.receipt).toBe('R-0002');
    execution = dr.execution;
    expect(dr.draft).toContain(`id: ${execution}`);

    // 在途投影拦住包范围之外的写入，放行范围内的。
    expect((await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'docs', 'x.md') }, cwd: p.root })).decision).toBe('deny');
    expect((await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'src', 'greeter.js') }, cwd: p.root })).decision).toBe('allow');
    expect((await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'xforge', '.audit', 'chain.jsonl') }, cwd: p.root })).reason).toContain('XF-ENFORCE-001');
    // 项目外的路径不归投影管。
    expect((await p.enforce({ tool_name: 'Write', tool_input: { file_path: '/tmp/xforge-brief-for-test.md' }, cwd: p.root })).decision).toBe('allow');

    await p.write('src/greeter.js', 'module.exports = () => "hello";\n');
    const run = await p.xforge('run', '--package', 'P-01');
    expect(run.exit, JSON.stringify(run.env)).toBe(0);
    expect((run.env.result as { gates: Array<{ gate: string; result: string; run: number }> }).gates[0]).toMatchObject({ gate: 'unit-tests', result: 'passed', run: 1 });

    await p.write(`xforge/changes/${CHANGE}/ledgers/deliveries/P-01.yaml`, [
      'kind: delivery', 'entries:', `  - id: ${execution}`, '    package: P-01', `    baseline_commit: ${p.head()}`,
      '    paths_changed: [src/greeter.js]', `    revision: ${'a'.repeat(64)}`, '    conclusion: succeeded',
      '    refs: [evidence/gates/unit-tests/1.yaml]', '    criteria: [{id: C-1, evidence: "test.js"}]', '    remaining: []',
      `    signer: ${execution}`, `    at: ${AT}`, '',
    ].join('\n'));
    const del = await p.xforge('advance', 'package', 'P-01', '--deliver');
    expect(del.exit, JSON.stringify(del.env)).toBe(0);
    expect((del.env.result as { to: string }).to).toBe('integrated'); // 交付即集成：没有人确认这一格

    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('verify');
  });

  it('verify: receipt signed, advance to ready-to-archive', async () => {
    const s = await p.xforge('state');
    const owed = (s.env.result as { owed: Array<{ id: string; status: string }> }).owed;
    expect(owed.find((o) => o.id === 'assurance')?.status).toBe('not-owed');
    await p.write(`xforge/changes/${CHANGE}/ledgers/verification-receipt.yaml`, `kind: verification-receipt\nentries:\n  - id: unit-tests\n    conclusion: passed\n    refs: [evidence/gates/unit-tests/2.yaml]\n    signer: "${SIGNER}"\n    at: ${AT}\n`);
    const sign = await p.xforge('attest', 'receipt');
    expect(sign.exit, JSON.stringify(sign.env)).toBe(0);
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('ready-to-archive');
  });

  it('archive: final approval, then archive; inspect is clean', async () => {
    const ap = await p.xforge('attest', 'approve', '--archive', '--decision', 'approved');
    expect(ap.exit, JSON.stringify(ap.env)).toBe(0);
    const ar = await p.xforge('advance', '--archive');
    expect(ar.exit, JSON.stringify(ar.env)).toBe(0);
    expect((ar.env.result as { to: string }).to).toBe('archived');
    const s = await p.xforge('state');
    expect((s.env.result as { position: { status: string } }).position.status).toBe('no-change');
    const i = await p.xforge('inspect', '--change', CHANGE);
    expect(i.exit, JSON.stringify(i.env)).toBe(0);
    expect(i.env.diagnostics.filter((d) => d.severity === 'blocking')).toEqual([]);
  });
});
