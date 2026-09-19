// design: cli §1 §2 §5 §6 — 命令面逐项：帮助文本里的每一种命令形式、每个参数、每种 show ref 都在这里被真实调用一次（CLI-01 CLI-02 CLI-04 的补全；D2 --text、§1.1 --field、D4 --change、D5 --scheme）。
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { Project, repoRoot, type Result } from '../helpers/project.js';

const CHANGE = 'C-20260915-surface';
const SIGNER = 'Test User <test@example.com>';
const AT = '2026-09-15T10:00:00Z';
const raw = (r: Result): string => (r.env.result as { raw?: string }).raw ?? '';
const code = (r: Result): string | undefined => r.env.diagnostics[0]?.code;
const blockers = (r: Result): string[] => ((r.env.result as { blockers?: Array<{ token: string }> }).blockers ?? []).map((b) => b.token);

describe('meta verbs and the no-project paths', () => {
  let bare: Project;
  beforeAll(async () => {
    bare = await Project.create('bare');
  });

  it('help (and no arguments at all) prints the command surface with exit 0', async () => {
    for (const args of [['help'], []]) {
      const r = await bare.xforge(...args);
      expect(r.exit).toBe(0);
      expect(raw(r)).toContain('xforge <命令>');
      for (const verb of ['state', 'show', 'inspect', 'run', 'attest', 'advance', 'init', 'sync', 'update', 'doctor', 'repair', 'remove', 'explain']) expect(raw(r)).toContain(verb);
    }
  });

  it('an unknown verb is a usage error on stderr with exit 2', async () => {
    const r = await bare.xforge('bogus');
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('未知命令 bogus');
  });

  it('version reports the package version without a project', async () => {
    const r = await bare.xforge('version');
    expect(r.exit).toBe(0);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    expect((r.env.result as { cli: string }).cli).toBe(pkg.version);
  });

  it('explain returns the dictionary entry; an unknown code is XF-STATE-005; no code is a usage error', async () => {
    const known = await bare.xforge('explain', 'XF-RUN-003');
    expect(known.exit).toBe(0);
    expect(known.env.result).toMatchObject({ code: 'XF-RUN-003', title: '门失败' });
    const unknown = await bare.xforge('explain', 'XF-NOPE-999');
    expect(unknown.exit).toBe(1);
    expect(code(unknown)).toBe('XF-STATE-005');
    expect((await bare.xforge('explain')).exit).toBe(2);
  });

  it('XF-STATE-002 every project verb outside a governed tree exits 3 and points at init', async () => {
    for (const args of [['state'], ['state', '--orient'], ['show', 'receipts'], ['inspect'], ['run'], ['advance'], ['attest', 'receipt'], ['sync'], ['update'], ['remove', '--confirm', basename(bare.root)]]) {
      const r = await bare.xforge(...args);
      expect(r.exit, args.join(' ')).toBe(3);
      expect(code(r), args.join(' ')).toBe('XF-STATE-002');
    }
  });

  it('--text renders the same outcome for a person; exit code unchanged', async () => {
    const r = await bare.xforge('state', '--text');
    expect(r.exit).toBe(3);
    const lines = raw(r).split('\n');
    expect(lines[0]).toBe('blocked · state');
    expect(lines[1]).toContain('[blocking] XF-STATE-002');
    expect(lines[2]).toContain('→ xforge init');
  });

  it('--field returns just that part of the envelope; a missing path is null', async () => {
    const r = await bare.xforge('state', '--field', 'diagnostics.0.code');
    expect(r.exit).toBe(3);
    expect(r.env as unknown).toBe('XF-STATE-002');
    expect((await bare.xforge('state', '--field', 'no.such.path')).env as unknown).toBe(null);
  });

  it('init --flow with an unknown flow is a usage error; init --language en projects the English Skills', async () => {
    expect((await bare.xforge('init', '--flow', 'nope')).exit).toBe(2);
    const r = await bare.xforge('init', '--flow', 'quick', '--language', 'en');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    const manifest = parse(readFileSync(join(bare.root, 'xforge', 'manifest.yaml'), 'utf8')) as { language: string; platforms: string[] };
    expect(manifest.language).toBe('en');
    expect(manifest.platforms).toEqual(['claude']);
    expect(readFileSync(join(bare.root, '.claude', 'skills', 'xforge', 'SKILL.md'), 'utf8')).toContain('You are the orchestrator');
  });

  it('CLI-44 with no tty and no options init takes the defaults instead of asking', async () => {
    const fresh = await Project.create('noninteractive');
    const r = await fresh.xforge('init'); // 没有 TTY：不问，不挂
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    const manifest = parse(readFileSync(join(fresh.root, 'xforge', 'manifest.yaml'), 'utf8')) as { language: string; platforms: string[]; flow: { default: string } };
    expect(manifest).toMatchObject({ language: 'zh-CN', platforms: ['claude'], flow: { default: 'solid' } });
    expect((await fresh.xforge('init', '--no-input')).exit).toBe(0); // 显式非交互：重入幂等，什么都不问
  });

  it('sync --platform projects only the named host, leaving the others alone', async () => {
    const r = await bare.xforge('sync', '--platform', 'codex');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    const files = (r.env.result as { files: string[] }).files;
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f.startsWith('.codex/') || f === 'AGENTS.md').toBe(true);
    expect(existsSync(join(bare.root, '.codex', 'skills', 'xforge', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(bare.root, 'AGENTS.md'), 'utf8')).toContain('<!-- XFORGE:BEGIN -->');
    const claudeOnly = await bare.xforge('sync', '--platform', 'claude');
    expect(claudeOnly.env.changed).toEqual([]);
  });
});

describe('the command surface on a quick change', () => {
  let p: Project;
  let other: Project;
  let execution = '';
  const c = (rel: string): string => `xforge/changes/${CHANGE}/${rel}`;

  beforeAll(async () => {
    p = await Project.create('surface');
    other = await Project.create('surface-other');
    await p.write('package.json', '{"name":"surface","version":"0.0.0"}\n');
    await p.write('test.js', 'process.exit(0);\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude');
    p.commit('init');
    await p.xforge('attest', 'verification', '--command', 'unit-tests=node test.js');
    await p.write(c('change.yaml'), `id: ${CHANGE}\ntitle: surface\nflow: quick\nrisk: low\nimpact: []\nbaseline_commit: ${p.head()}\n`);
    await p.write(c('proposal.md'), '# surface\n\n## 背景\nx\n## 目标\ny\n## 非目标\nz\n## 为什么选这条流程\nlow\n## 影响面\nnone\n');
    await p.write(c('scope.yaml'), 'scheme: default\npaths: ["src/**"]\n');
    await p.write(c('work-packages.yaml'), 'packages:\n  - id: P-01\n    title: one\n    depends_on: []\n    paths: ["src/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-1, text: "works"}]\n    review: none\n');
    // 一条接口基线，给 show interface: 用。
    await p.write('xforge/interfaces/index.yaml', 'domains:\n  - {id: order-core, path: order-core}\n');
    await p.write('xforge/interfaces/order-core/index.yaml', 'entries:\n  - {id: "fn:createOrder", capability: api, title: 创建订单}\n');
    await p.write('xforge/interfaces/order-core/api.md', '# api\n\n<!-- xforge:entries:begin kind=elements -->\n### Element: fn:createOrder · 创建订单\nsummary: (input: NewOrder) => Order\n<!-- xforge:entries:end -->\n');
  });

  it('--cwd points every verb at another directory', async () => {
    const r = await other.xforge('state', '--cwd', p.root);
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(r.env.change).toBe(CHANGE);
  });

  it('D4 XF-STATE-001 --change names a missing change (exit 2); two open changes need --change; inspect --all covers both', async () => {
    const missing = await p.xforge('state', '--change', 'C-20260915-nope');
    expect(missing.exit).toBe(2);
    expect(code(missing)).toBe('XF-STATE-001');
    await p.write('xforge/changes/C-20260915-second/change.yaml', `id: C-20260915-second\ntitle: second\nflow: quick\nrisk: low\nimpact: []\nbaseline_commit: ${p.head()}\n`);
    const ambiguous = await p.xforge('state');
    expect(ambiguous.exit).toBe(2);
    expect(code(ambiguous)).toBe('XF-STATE-001');
    expect(ambiguous.env.diagnostics[0]?.message).toContain('2 个未归档');
    const named = await p.xforge('state', '--change', CHANGE);
    expect(named.exit).toBe(0);
    const all = await p.xforge('inspect', '--all');
    expect([0, 3]).toContain(all.exit);
    expect(all.env.diagnostics.filter((d) => d.severity === 'blocking')).toEqual([]);
    rmSync(join(p.root, 'xforge', 'changes', 'C-20260915-second'), { recursive: true });
  });

  it('D5 --scheme: an illegal or reserved id is a usage error; a legal one addresses that scheme', async () => {
    for (const bad of ['Alt', 'ledgers', 'evidence', 'specs', 'interfaces', '1x']) {
      const r = await p.xforge('state', '--scheme', bad);
      expect(r.exit, bad).toBe(2);
      expect(code(r), bad).toBe('XF-STATE-001');
    }
    expect((await p.xforge('state', '--scheme', 'default')).exit).toBe(0);
    const alt = await p.xforge('state', '--scheme', 'alt');
    expect(alt.exit, JSON.stringify(alt.env)).toBe(0);
    expect(alt.env.scheme).toBe('alt');
    expect((alt.env.result as { position: { stage: string } }).position.stage).toBe('propose');
    // 具名方案只是被寻址，没写任何文件：Change 目录下没有它，state 也不列它。
    expect(existsSync(join(p.root, c('alt')))).toBe(false);
    expect((await p.xforge('state')).env.result).not.toHaveProperty('schemes');
  });

  it('--field and --text on a real state', async () => {
    expect((await p.xforge('state', '--field', 'result.position.stage')).env as unknown).toBe('propose');
    const text = await p.xforge('state', '--text');
    expect(text.exit).toBe(0);
    expect(raw(text).split('\n')[0]).toBe(`ok · state · ${CHANGE}`);
    expect(raw(text)).toContain('next: xforge run');
  });

  it('show: every ref kind in the help resolves, and every miss is XF-STATE-005 with the alternatives', async () => {
    expect((await p.xforge('show')).exit).toBe(2);
    const stage = await p.xforge('show', 'stage:propose');
    expect(stage.exit, JSON.stringify(stage.env)).toBe(0);
    expect((stage.env.result as { content: Array<{ id: string }> }).content.map((x) => x.id)).toContain('proposal');
    const whole = await p.xforge('show', 'doc:proposal.md');
    expect((whole.env.result as { content: string }).content).toContain('## 目标');
    const heading = await p.xforge('show', 'doc:proposal.md#目标');
    expect((heading.env.result as { content: string; omitted: string[] }).omitted).toContain('背景');
    const consti = await p.xforge('show', 'constitution:不做无测试的行为变更');
    expect((consti.env.result as { content: string }).content).toContain('## 不做无测试的行为变更');
    const iface = await p.xforge('show', 'interface:fn:createOrder');
    expect(iface.exit, JSON.stringify(iface.env)).toBe(0);
    expect((iface.env.result as { content: { body: string } }).content.body).toContain('summary:');
    const pkg = await p.xforge('show', 'package:P-01');
    expect((pkg.env.result as { content: { state: string; delivery: null } }).content).toMatchObject({ state: 'ready', delivery: null });
    const receipts = await p.xforge('show', 'receipts');
    expect((receipts.env.result as { content: unknown[] }).content).toEqual([]);
    for (const ref of ['stage:nope', 'doc:../etc/passwd', 'doc:nope.md', 'doc:proposal.md#nope', 'spec:REQ-x-y-999', 'interface:fn:nope', 'constitution:nope', 'gate:structure', 'gate:nope/1', 'gate:', 'ledger:verification-receipt', 'package:P-99', 'index:nope', 'weird:x']) {
      const r = await p.xforge('show', ref);
      expect(r.exit, ref).toBe(1);
      expect(code(r), ref).toBe('XF-STATE-005');
    }
    const wrongHeading = await p.xforge('show', 'doc:proposal.md#nope');
    expect(wrongHeading.env.diagnostics[0]?.message).toContain('目标');
  });

  it('run --gate names gates; a current gate is not rerun unless --force; an unknown gate is XF-MODEL-002 (exit 3)', async () => {
    const first = await p.xforge('run', '--gate', 'structure');
    expect(first.exit, JSON.stringify(first.env)).toBe(0);
    expect((first.env.result as { gates: Array<{ gate: string; run: number; result: string }> }).gates).toEqual([expect.objectContaining({ gate: 'structure', run: 1, result: 'passed' })]);
    const again = await p.xforge('run', '--gate', 'structure');
    expect((again.env.result as { gates: Array<{ run: number }> }).gates[0]?.run).toBe(1);
    const forced = await p.xforge('run', '--gate', 'structure', '--force');
    expect((forced.env.result as { gates: Array<{ run: number }> }).gates[0]?.run).toBe(2);
    const shown = await p.xforge('show', 'gate:structure/1');
    expect((shown.env.result as { content: { run: number } }).content.run).toBe(1);
    const unknown = await p.xforge('run', '--gate', 'nope');
    expect(unknown.exit).toBe(3);
    expect(code(unknown)).toBe('XF-MODEL-002');
  });

  it('advance --workdir records that directory as the projection identity', async () => {
    const r = await p.xforge('advance', '--workdir', p.root);
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    const dir = join(p.root, c('evidence/projections'));
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect((parse(readFileSync(join(dir, files[0]!), 'utf8')) as { workdir: string; kind: string }).workdir).toBe(p.root);
  });

  it('RF-31 a stage-scoped gate run from propose is not current at apply even though the Change directory did not change', async () => {
    const r = await p.xforge('run', '--gate', 'structure');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect((r.env.result as { gates: Array<{ run: number; result: string }> }).gates[0]).toMatchObject({ run: 3, result: 'passed' });
    const rec = parse(readFileSync(join(p.root, c('evidence/gates/structure/3.yaml')), 'utf8')) as { stage: string };
    expect(rec.stage).toBe('apply');
  });

  it('usage errors: every malformed attest / advance form exits 2 without touching the tree', async () => {
    const before = JSON.stringify(readdirSync(join(p.root, c('evidence/receipts'))));
    for (const args of [
      ['attest'], ['attest', 'bogus'], ['attest', 'approve'], ['attest', 'approve', '--decision', 'maybe'], ['attest', 'entry'], ['attest', 'entry', 'review-findings'],
      ['attest', 'delivery', 'P-01'], ['attest', 'delivery', 'P-01', '--step', 'ship'], ['attest', 'verification'], ['attest', 'verification', '--command', 'no-equals-sign'],
      ['advance', 'package'], ['advance', 'package', 'P-01'],
    ]) {
      const r = await p.xforge(...args);
      expect(r.exit, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toContain('用法');
    }
    expect(JSON.stringify(readdirSync(join(p.root, c('evidence/receipts'))))).toBe(before);
  });

  it('apply: dispatch, XF-ENFORCE-002 outside the package, deliver (= integrate)', async () => {
    const d = await p.xforge('advance', 'package', 'P-01', '--dispatch');
    expect(d.exit, JSON.stringify(d.env)).toBe(0);
    execution = (d.env.result as { execution: string }).execution;
    const denied = await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'docs', 'x.md') }, cwd: p.root });
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('XF-ENFORCE-002');
    const shown = await p.xforge('show', 'package:P-01');
    expect((shown.env.result as { content: { state: string; projections: Array<{ in_flight: boolean }> } }).content).toMatchObject({ state: 'running', projections: [{ in_flight: true }] });
    await p.write('src/one.js', 'module.exports = 1;\n');
    expect((await p.xforge('run', '--package', 'P-01')).exit).toBe(0);
    await p.write(c('ledgers/deliveries/P-01.yaml'), `kind: delivery\nentries:\n  - id: ${execution}\n    package: P-01\n    baseline_commit: ${p.head()}\n    paths_changed: [src/one.js]\n    revision: ${'a'.repeat(64)}\n    conclusion: succeeded\n    refs: [evidence/gates/unit-tests/1.yaml]\n    criteria: [{id: C-1, evidence: "test.js"}]\n    remaining: []\n    signer: ${execution}\n    at: ${AT}\n`);
    const del = await p.xforge('advance', 'package', 'P-01', '--deliver');
    expect(del.exit, JSON.stringify(del.env)).toBe(0);
    expect((del.env.result as { to: string }).to).toBe('integrated');
    const ledger = await p.xforge('show', 'ledger:delivery/P-01');
    expect(ledger.exit, ledger.stderr + JSON.stringify(ledger.env)).toBe(0);
    expect((ledger.env.result as { content: string }).content).toContain(`id: ${execution}`);
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('verify');
  });

  it('verify then --decision rejected: the rejection is recorded, blocks the archive, and a later approval clears it', async () => {
    await p.write(c('ledgers/verification-receipt.yaml'), `kind: verification-receipt\nentries:\n  - id: unit-tests\n    conclusion: passed\n    refs: [evidence/gates/unit-tests/1.yaml]\n    signer: "${SIGNER}"\n    at: ${AT}\n`);
    const signed = await p.xforge('attest', 'receipt');
    expect(signed.exit, JSON.stringify(signed.env)).toBe(0);
    expect((await p.xforge('show', 'ledger:verification-receipt')).exit).toBe(0);
    const a = await p.xforge('advance');
    expect((a.env.result as { to: string }).to).toBe('ready-to-archive');
    const rejected = await p.xforge('attest', 'approve', '--archive', '--decision', 'rejected', '--note', 'not yet');
    expect(rejected.exit, JSON.stringify(rejected.env)).toBe(0);
    const state = await p.xforge('state');
    expect(blockers(state)).toContain('approval-rejected');
    const archive = await p.xforge('advance', '--archive');
    expect(archive.exit).toBe(1);
    expect(blockers(archive)).toContain('approval-rejected');
    expect((await p.xforge('attest', 'approve', '--archive', '--decision', 'approved')).exit).toBe(0);
    const done = await p.xforge('advance', '--archive');
    expect(done.exit, JSON.stringify(done.env)).toBe(0);
    expect((done.env.result as { to: string }).to).toBe('archived');
    const receipts = await p.xforge('show', 'receipts', '--change', CHANGE);
    expect((receipts.env.result as { content: Array<{ kind: string }> }).content.map((r) => r.kind)).toContain('archive');
  });
});

describe('a flag the command does not know is a usage error (CLI-50)', () => {
  let p: Project;
  beforeAll(async () => {
    p = await Project.create('flags');
    await p.xforge('init', '--flow', 'quick');
  });

  it('打错的开关当场退出 2 并列出认得的，而不是被吞掉', async () => {
    const r = await p.xforge('doctor', '--whatever');
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('--whatever');
    expect(r.stderr).toContain('--platform');
  });

  it('不支持的开关也是用法错：吞掉它等于对调用方撒谎', async () => {
    // repair 没有 --platform（它按发现算范围）：吞掉就会「说改了 codex、其实改了 claude」。
    const wrong = await p.xforge('repair', '--platform', 'codex');
    expect(wrong.exit).toBe(2);
    expect(wrong.stderr).toContain('--platform');
    // 而 doctor 有它，同一个开关在那里照常工作。
    expect((await p.xforge('doctor', '--platform', 'claude')).exit).toBe(0);
  });

  it('通用开关对每个命令都认', async () => {
    expect((await p.xforge('doctor', '--text')).exit).toBe(0);
    // --field 以信封为根：断言取回的值本身，否则 --field 整个坏掉这条也会过。
    const field = await p.xforge('state', '--field', 'result.position');
    expect(field.exit).toBe(0);
    // --field 的 stdout 就是那一段本身，不是信封；helper 直接把它 JSON.parse 了。
    expect(field.env as unknown as { status: string }).toHaveProperty('status');
    expect((await p.xforge('repair', '--dry-run')).exit).toBe(0);
  });
});
