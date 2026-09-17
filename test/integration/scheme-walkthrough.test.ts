// design: cli §2 D5 — CLI-30 CLI-31：默认方案与具名方案各在自己的 worktree 里推进同一个 Change；RF-32 门互不过期、RF-33 作用域的 scheme、RF-34 不共用工作目录；归档是 Change 级。
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project, type Result } from '../helpers/project.js';

const CHANGE = 'C-20260915-dual';
const SIGNER = 'Test User <test@example.com>';
const AT = '2026-09-15T10:00:00Z';
const SHA = 'd'.repeat(64);
const code = (r: Result): string | undefined => r.env.diagnostics[0]?.code;
const blockers = (r: Result): string[] => ((r.env.result as { blockers?: Array<{ token: string }> }).blockers ?? []).map((b) => b.token);

describe('two schemes on one change', () => {
  let p: Project;
  let wt = '';
  let execution = '';
  const c = (rel: string): string => `xforge/changes/${CHANGE}/${rel}`;
  const b = (rel: string): string => c(`blackbox/${rel}`);
  /** 具名方案的会话：cwd 是它的 worktree，XFORGE_ROOT 指回主检出，XFORGE_SCHEME 选方案。 */
  const session = (...args: string[]): Promise<Result> => p.xforgeIn({ cwd: wt, env: { XFORGE_ROOT: p.root, XFORGE_SCHEME: 'blackbox' } }, ...args);

  beforeAll(async () => {
    p = await Project.create('dual');
    await p.write('package.json', '{"name":"dual","version":"0.0.0"}\n');
    await p.write('test.js', 'process.exit(0);\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude');
    p.commit('init');
    await p.xforge('attest', 'verification', '--command', 'unit-tests=node test.js');
    await p.write(c('change.yaml'), `id: ${CHANGE}\ntitle: dual\nflow: quick\nrisk: low\nimpact: []\nbaseline_commit: ${p.head()}\n`);
    await p.write(c('proposal.md'), '# dual\n\n## 背景\nx\n## 目标\ny\n## 非目标\nz\n## 为什么选这条流程\nlow\n## 影响面\nnone\n');
    await p.write(c('scope.yaml'), 'scheme: default\npaths: ["src/**"]\n');
    await p.write(c('work-packages.yaml'), 'packages:\n  - id: P-01\n    title: impl\n    depends_on: []\n    paths: ["src/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-1, text: "impl works"}]\n    review: none\n');
    wt = realpathSync(mkdtempSync(join(tmpdir(), 'xforge-dual-wt-')));
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'HEAD'], { cwd: p.root });
  });

  it('D5 a named scheme starts at the first stage; the shared spec side is not owed, the impl side is, and its skeleton names the scheme', async () => {
    const s = await p.xforge('state', '--orient', '--scheme', 'blackbox');
    expect(s.exit, JSON.stringify(s.env)).toBe(0);
    expect(s.env.scheme).toBe('blackbox');
    const r = s.env.result as { position: { stage: string }; owed: Array<{ id: string; status: string; because?: string }>; orient: { stage: { produces: Array<{ id: string; draft?: string }> } } };
    expect(r.position.stage).toBe('propose');
    expect(r.owed.find((o) => o.id === 'proposal')).toMatchObject({ status: 'not-owed', because: 'side=spec, non-default scheme' });
    expect(r.owed.find((o) => o.id === 'scope')?.status).toBe('pending');
    expect(r.orient.stage.produces.find((x) => x.id === 'scope')?.draft).toContain('scheme: blackbox');
  });

  it('RF-33 the structure gate refuses a scope declared for another scheme; state then lists both schemes', async () => {
    await p.write(b('scope.yaml'), 'scheme: default\npaths: ["tests/**"]\n');
    await p.write(b('work-packages.yaml'), 'packages:\n  - id: P-01\n    title: blackbox tests\n    depends_on: []\n    paths: ["tests/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-1, text: "tests exist"}]\n    review: none\n');
    const wrong = await p.xforge('run', '--gate', 'structure', '--scheme', 'blackbox');
    expect(wrong.exit).toBe(1);
    expect(wrong.env.diagnostics.find((d) => d.code === 'XF-RUN-003')?.message).toContain('scheme 是 default');
    await p.write(b('scope.yaml'), 'scheme: blackbox\npaths: ["tests/**"]\n');
    const right = await p.xforge('run', '--gate', 'structure', '--scheme', 'blackbox');
    expect(right.exit, JSON.stringify(right.env)).toBe(0);
    expect((await p.xforge('state')).env.result).toMatchObject({ schemes: ['default', 'blackbox'] });
    // 具名方案的证据在它自己的目录下，不在 Change 根。
    expect(existsSync(join(p.root, b('evidence/gates/structure/1.yaml')))).toBe(true);
    expect(existsSync(join(p.root, c('evidence/gates/structure/2.yaml')))).toBe(false);
  });

  it('RF-32 one scheme editing its own files does not stale the other scheme’s gate', async () => {
    expect((await p.xforge('run', '--gate', 'structure')).exit).toBe(0);
    await p.write(c('scope.yaml'), 'scheme: default\npaths: ["src/**"]   # touched\n');
    expect(blockers(await p.xforge('state'))).toContain('gate-stale');
    expect(blockers(await p.xforge('state', '--scheme', 'blackbox'))).not.toContain('gate-stale');
    await p.write(b('scope.yaml'), 'scheme: blackbox\npaths: ["tests/**"]   # touched\n');
    expect(blockers(await p.xforge('state', '--scheme', 'blackbox'))).toContain('gate-stale');
    expect((await p.xforge('run', '--gate', 'structure')).exit).toBe(0);
    expect(blockers(await p.xforge('state'))).not.toContain('gate-stale');
  });

  it('CLI-30 show doc: resolves the impl side per scheme', async () => {
    const mine = await p.xforge('show', 'doc:work-packages.yaml');
    const theirs = await p.xforge('show', 'doc:work-packages.yaml', '--scheme', 'blackbox');
    expect((mine.env.result as { content: string }).content).toContain('src/**');
    expect((theirs.env.result as { content: string }).content).toContain('tests/**');
    const shared = await p.xforge('show', 'doc:proposal.md#目标', '--scheme', 'blackbox');
    expect((shared.env.result as { content: string }).content).toContain('y');
  });

  it('RF-34 the default scheme enters apply in the main checkout; the named scheme may not use the same workdir', async () => {
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('apply');
    const clash = await p.xforge('advance', '--scheme', 'blackbox', '--workdir', p.root);
    expect(clash.exit).toBe(1);
    expect(code(clash)).toBe('XF-ADVANCE-010');
    expect(clash.env.diagnostics[0]?.message).toContain('default');
  });

  it('CLI-31 in its worktree the named scheme needs no flags: XFORGE_ROOT and XFORGE_SCHEME give the same envelope as --cwd/--scheme', async () => {
    const viaEnv = await session('state');
    const viaFlags = await p.xforge('state', '--scheme', 'blackbox');
    expect(viaEnv.exit, JSON.stringify(viaEnv.env)).toBe(0);
    expect(JSON.stringify(viaEnv.env)).toBe(JSON.stringify(viaFlags.env));
    // 没有 XFORGE_ROOT，worktree 里看到的是它自己检出的 xforge/ 副本：另一棵治理树，没有这个 Change。
    const bare = await p.xforgeIn({ cwd: wt }, 'state');
    expect((bare.env.result as { position: { status: string } }).position.status).toBe('no-change');
    const a = await session('advance', '--workdir', wt);
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('apply');
  });

  it('CLI-30 enforcement follows each worktree’s own projection', async () => {
    const env = { XFORGE_ROOT: p.root };
    expect((await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(wt, 'tests', 'test_a.py') }, cwd: wt }, { cwd: wt, env })).decision).toBe('allow');
    const denied = await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(wt, 'src', 'x.js') }, cwd: wt }, { cwd: wt, env });
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('XF-ENFORCE-002');
    expect((await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'src', 'one.js') }, cwd: p.root })).decision).toBe('allow');
    expect((await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'tests', 'test_a.py') }, cwd: p.root })).decision).toBe('deny');
  });

  it('the named scheme delivers its package in its worktree: gate command, git diff and delivery all judged there', async () => {
    const d = await session('advance', 'package', 'P-01', '--dispatch', '--workdir', wt);
    expect(d.exit, JSON.stringify(d.env)).toBe(0);
    execution = (d.env.result as { execution: string }).execution;
    execFileSync('mkdir', ['-p', join(wt, 'tests')]);
    execFileSync('sh', ['-c', `printf 'def test_a():\\n    assert True\\n' > ${JSON.stringify(join(wt, 'tests', 'test_a.py'))}`]);
    const run = await session('run', '--package', 'P-01');
    expect(run.exit, JSON.stringify(run.env)).toBe(0);
    const runs = readdirSync(join(p.root, b('evidence/gates/unit-tests'))).filter((f) => f.endsWith('.yaml'));
    expect(runs.length).toBe(1);
    await p.write(b('ledgers/deliveries/P-01.yaml'), `kind: delivery\nentries:\n  - id: ${execution}\n    package: P-01\n    baseline_commit: ${p.head()}\n    paths_changed: [tests/test_a.py]\n    revision: ${SHA}\n    conclusion: succeeded\n    refs: [evidence/gates/unit-tests/${runs[0]}]\n    criteria: [{id: C-1, evidence: "tests/test_a.py"}]\n    remaining: []\n    signer: ${execution}\n    at: ${AT}\n`);
    const del = await session('advance', 'package', 'P-01', '--deliver');
    expect(del.exit, JSON.stringify(del.env)).toBe(0);
    expect((del.env.result as { to: string }).to).toBe('integrated');
    const a = await session('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('verify');
    // 主检出里的默认方案不受影响：还在 apply，包还是 ready。
    const mine = await p.xforge('state');
    expect((mine.env.result as { position: { stage: string }; packages: Array<{ state: string }> }).position.stage).toBe('apply');
    expect((mine.env.result as { packages: Array<{ state: string }> }).packages[0]?.state).toBe('ready');
  });

  it('inspect --all covers both schemes and is clean', async () => {
    const r = await p.xforge('inspect', '--all');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(r.env.diagnostics.filter((d) => d.severity === 'blocking')).toEqual([]);
    const i = await session('inspect');
    expect(i.exit, JSON.stringify(i.env)).toBe(0);
  });

  it('archive is Change-level: the named scheme archives, the default scheme is frozen at archived', async () => {
    await p.write(b('ledgers/verification-receipt.yaml'), `kind: verification-receipt\nentries:\n  - id: unit-tests\n    conclusion: passed\n    refs: [evidence/gates/unit-tests/1.yaml]\n    signer: "${SIGNER}"\n    at: ${AT}\n`);
    const signed = await session('attest', 'receipt');
    expect(signed.exit, JSON.stringify(signed.env)).toBe(0);
    const a = await session('advance');
    expect((a.env.result as { to: string }).to).toBe('ready-to-archive');
    expect((await session('attest', 'approve', '--archive', '--decision', 'approved')).exit).toBe(0);
    const done = await session('advance', '--archive');
    expect(done.exit, JSON.stringify(done.env)).toBe(0);
    expect((done.env.result as { to: string }).to).toBe('archived');
    expect(existsSync(join(p.root, c('archived.yaml')))).toBe(true);
    const frozen = await p.xforge('state', '--change', CHANGE);
    expect((frozen.env.result as { position: { status: string } }).position.status).toBe('archived');
    const refused = await p.xforge('advance', '--change', CHANGE);
    expect(refused.exit).toBe(1);
    expect(code(refused)).toBe('XF-ADVANCE-001');
    expect((await p.xforge('state')).env.result).toMatchObject({ position: { status: 'no-change' } });
    expect((await p.xforge('inspect', '--change', CHANGE)).exit).toBe(0);
    expect((await session('inspect', '--change', CHANGE)).exit).toBe(0);
  });
});
