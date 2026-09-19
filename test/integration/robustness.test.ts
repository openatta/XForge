// design: cli §1 §2 — 破坏与边界：CLI-01/02/04/05/06/07/08/10/12/14/16/17/21/23/25/28，RF-11/12/30/31。
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validate } from '../../src/model/schemas.js';
import type { Envelope, GateRun } from '../../src/model/types.js';
import { Project, repoRoot } from '../helpers/project.js';

const CHANGE = 'C-20260915-robust';
const SIGNER = 'Test User <test@example.com>';
const AT = '2026-09-15T10:00:00Z';

const expectOk = (r: { exit: number; env: Envelope }, what = ''): void => {
  expect(r.exit, `${what} ${JSON.stringify(r.env).slice(0, 600)}`).toBe(0);
};

describe('robustness', () => {
  let p: Project;
  const c = (rel: string): string => `xforge/changes/${CHANGE}/${rel}`;
  const abs = (rel: string): string => join(p.root, c(rel));

  beforeAll(async () => {
    p = await Project.create('robust');
    await p.write('package.json', '{"name":"r"}\n');
    await p.write('test.js', 'console.log("ran"); process.exit(0);\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'solid', '--platform', 'claude', '--platform', 'codex');
    // 规格治理开，带一个大域，用来测 0a 段有界。
    const manifestPath = join(p.root, 'xforge', 'manifest.yaml');
    const manifest = parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['governance'] = { spec: true, interface: false };
    writeFileSync(manifestPath, (await import('yaml')).stringify(manifest));
    await p.write('AGENTS.md', '# mine\n\nkeep this line\n');
    p.commit('init');
    await p.xforge('attest', 'verification', '--command', 'unit-tests=node test.js');
    await p.write(c('change.yaml'), `id: ${CHANGE}\ntitle: r\nflow: solid\nrisk: low\nimpact: []\nbaseline_commit: ${p.head()}\n`);
    await p.write(c('proposal.md'), '# r\n\n## 背景\nb\n## 目标\ng\n## 非目标\nn\n## 为什么选这条流程\nlow\n## 影响面\nnone\n');
    await p.write(c('specs/orders/create.md'), '# c\n\n## ADDED\n### Requirement: REQ-orders-create-001 · a\n- **WHEN** x\n- **THEN** y\n');
  });

  it('CLI-01 CLI-02 every command output validates as an envelope; ok, blocking and exit code agree', async () => {
    const outputs: Array<[Envelope, number]> = [];
    for (const args of [['state'], ['state', '--orient'], ['inspect'], ['run'], ['show', 'doc:proposal.md#目标'], ['show', 'nope:x'], ['advance', '--no-run'], ['version']]) {
      const r = await p.xforge(...args);
      outputs.push([r.env, r.exit]);
    }
    for (const [env, exit] of outputs) {
      expect(validate('envelope', env), JSON.stringify(env).slice(0, 200)).toEqual({ ok: true });
      const blocking = env.diagnostics.some((d) => d.severity === 'blocking');
      expect(env.ok).toBe(!blocking);
      if (exit === 3) expect(env.diagnostics.some((d) => /^XF-(INSPECT|MODEL)-/.test(d.code))).toBe(true);
      if (exit === 1) expect(blocking).toBe(true);
      if (exit === 0) expect(blocking).toBe(false);
    }
  });

  it('CLI-07 every blocker names a verb and a legal remedy command', async () => {
    const r = await p.xforge('state');
    const blockers = (r.env.result as { blockers: Array<{ verb: string; remedy: { command?: string } }> }).blockers;
    expect(blockers.length).toBeGreaterThan(0);
    for (const b of blockers) {
      expect(['write', 'run', 'attest', 'advance', 'inspect']).toContain(b.verb);
      if (b.remedy.command) expect(b.remedy.command).toMatch(/^xforge (state|show|run|attest|advance|inspect)\b/);
    }
  });

  it('CLI-05 CLI-06 RF-18 orientation is byte-identical across calls and its invariants do not grow with entries', async () => {
    const one = await p.xforge('state', '--orient');
    const two = await p.xforge('state', '--orient');
    expect(JSON.stringify(one.env)).toBe(JSON.stringify(two.env));
    const size = (env: Envelope): number => JSON.stringify((env.result as { orient: { invariants: unknown } }).orient.invariants).length;
    const before = size(one.env);
    // 往规格基线塞 300 条条目：域层索引不变，0a 段大小不变。
    const entries = Array.from({ length: 300 }, (_, i) => `  - {id: REQ-big-x-${String(i).padStart(3, '0')}, capability: x, title: t${i}}`).join('\n');
    await p.write('xforge/specs/big/index.yaml', `entries:\n${entries}\n`);
    await p.write('xforge/specs/big/x.md', `# x\n\n<!-- xforge:entries:begin kind=requirements -->\n${Array.from({ length: 300 }, (_, i) => `### Requirement: REQ-big-x-${String(i).padStart(3, '0')} · t${i}\n- **WHEN** a\n`).join('')}<!-- xforge:entries:end -->\n`);
    const idx = parse(readFileSync(join(p.root, 'xforge', 'specs', 'index.yaml'), 'utf8')) as { domains: unknown[] };
    idx.domains.push({ id: 'big', title: 'big', capabilities: [{ id: 'x', path: 'big/x.md' }] });
    await p.write('xforge/specs/index.yaml', (await import('yaml')).stringify(idx));
    const three = await p.xforge('state', '--orient');
    expect(size(three.env) - before).toBeLessThan(120); // 只多了一个域的名字
  });

  it('CLI-10 run has no way to take a command from the caller', async () => {
    // CLI-50 之后这条更强了：夹带的开关当场是用法错，而不是被静默忽略。
    const smuggled = await p.xforge('run', '--gate', 'unit-tests', '--command', 'echo injected', '--force');
    expect(smuggled.exit).toBe(2);
    expect(smuggled.stderr).toContain('--command');
    // 跑的仍然只有声明里的那条命令。
    const r = await p.xforge('run', '--gate', 'unit-tests', '--force');
    const gates = (r.env.result as { gates: Array<{ gate: string; result: string; log?: string }> }).gates;
    const log = readFileSync(join(p.root, gates[0]!.log!), 'utf8');
    expect(log).toContain('ran');
    expect(log).not.toContain('injected');
  });

  it('RF-11 RF-12 RF-30 RF-31 gate runs bind their inputs; signing the receipt does not stale the gates it certifies', async () => {
    await p.xforge('run');
    const runs = readdirSync(abs('evidence/gates/structure')).filter((f) => f.endsWith('.yaml'));
    const run = parse(readFileSync(abs(`evidence/gates/structure/${runs.at(-1)}`), 'utf8')) as GateRun;
    expect(run.inputs).toBeDefined();
    expect(run.inputs!.some((g) => g.includes('ledgers/**') && g.startsWith('!'))).toBe(true); // RF-30
    expect(run.accepted).toBeUndefined(); // RF-12：structure 不受理台账；受理结果只在 ledgers 门的记录里
    const s1 = await p.xforge('state');
    const stale1 = (s1.env.result as { blockers: Array<{ token: string; ref: string }> }).blockers.filter((b) => b.token === 'gate-stale');
    await p.write(c('ledgers/verification-receipt.yaml'), `kind: verification-receipt\nentries:\n  - id: structure\n    conclusion: passed\n    refs: [x]\n    signer: "${SIGNER}"\n    at: ${AT}\n`);
    const s2 = await p.xforge('state');
    const stale2 = (s2.env.result as { blockers: Array<{ token: string; ref: string }> }).blockers.filter((b) => b.token === 'gate-stale');
    expect(stale2).toEqual(stale1); // 写收据不让任何门过期
  });

  it('CLI-16 advance returns the very slice state --orient will report next', async () => {
    // design 站欠的三份先写上：RF-31 之后，propose 站的 structure 记录不再算 design 站的当前。
    await p.write(c('scope.yaml'), 'scheme: default\npaths: ["src/**"]\n');
    await p.write(c('design.md'), ['# 设计', '', '## 技术路径', 'a', '## 集成点', 'b', '## 失败模式', 'c', '## 迁移与回滚', 'd', '## 被否决的方案', '<!-- xforge:entries:begin kind=alternatives -->', '- e', '<!-- xforge:entries:end -->', ''].join('\n'));
    await p.write(c('work-packages.yaml'), 'packages:\n  - id: P-01\n    title: t\n    depends_on: []\n    paths: ["src/core/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-1, text: x}]\n    review: none\n');
    await p.write(c('ledgers/exit/spec-conflicts.yaml'), 'kind: exit/spec-conflicts\nentries: []\n'); // design 站的出口条件：没矛盾就空（skills D15）
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    const fromAdvance = (a.env.result as { stage: unknown }).stage;
    const s = await p.xforge('state', '--orient');
    const fromState = (s.env.result as { orient: { stage: unknown } }).orient.stage;
    expect(JSON.stringify(fromAdvance)).toBe(JSON.stringify(fromState));
  });

  it('CLI-28 every show ref answers, and a heading slice reports what it omitted', async () => {
    const stage = await p.xforge('show', 'stage:design');
    expect(stage.exit).toBe(0);
    const doc = await p.xforge('show', 'doc:proposal.md#目标');
    expect((doc.env.result as { omitted: string[] }).omitted).toEqual(['背景', '非目标', '为什么选这条流程', '影响面']);
    expectOk(await p.xforge('show', 'constitution:不做无测试的行为变更'), "show, constitution:不做无测试的行为变更");
    expectOk(await p.xforge('show', 'gate:structure'), "show, gate:structure");
    expectOk(await p.xforge('show', 'ledger:verification-receipt'), "show, ledger:verification-receipt");
    expectOk(await p.xforge('show', 'receipts'), "show, receipts");
    expectOk(await p.xforge('show', 'index:big'), "show, index:big");
    expectOk(await p.xforge('show', 'spec:REQ-big-x-007'), "show, spec:REQ-big-x-007");
    const missing = await p.xforge('show', 'spec:REQ-none');
    expect(missing.env.diagnostics[0]?.code).toBe('XF-STATE-005');
  });

  it('CLI-23 sync keeps everything outside the marker block byte for byte', async () => {
    await p.xforge('sync'); // AGENTS.md 是 init 之后才由人写的，先让 sync 把标记块加上
    const before = readFileSync(join(p.root, 'AGENTS.md'), 'utf8');
    expect(before).toContain('keep this line');
    expect(before).toContain('<!-- XFORGE:BEGIN -->');
    await p.write('AGENTS.md', before + '\nappended by a person\n');
    await p.xforge('sync');
    const after = readFileSync(join(p.root, 'AGENTS.md'), 'utf8');
    expect(after.startsWith('# mine\n\nkeep this line\n')).toBe(true);
    expect(after.endsWith('\nappended by a person\n')).toBe(true);
    execFileSync('git', ['checkout', '--', 'AGENTS.md'], { cwd: p.root }); // 否则后面的 apply 会把它报成无归属改动
  });

  it('CLI-12 CLI-14 CLI-32 a delivery that fails the integration check leaves chain and receipts untouched; one that passes is integrated', async () => {
    // 前面的用例已经把位置推到了某一站；这里按位置把 Change 推到 apply，不假设起点。
    const stageNow = async (): Promise<string | null> => ((await p.xforge('state')).env.result as { position: { stage: string | null } }).position.stage;
    for (let guard = 0; guard < 6 && (await stageNow()) !== 'apply'; guard += 1) {
      const stage = await stageNow();
      if (stage === 'design' || !existsSync(abs('work-packages.yaml'))) {
        await p.write(c('scope.yaml'), 'scheme: default\npaths: ["src/**"]\n');
        await p.write(c('design.md'), '# d\n\n## 技术路径\nx\n## 集成点\nx\n## 失败模式\nx\n## 迁移与回滚\nx\n## 被否决的方案\n<!-- xforge:entries:begin kind=alternatives -->\n- a\n<!-- xforge:entries:end -->\n');
        await p.write(c('work-packages.yaml'), 'packages:\n  - id: P-01\n    title: t\n    depends_on: []\n    paths: ["src/core/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-1, text: x}]\n    review: none\n');
        await p.write(c('ledgers/exit/spec-conflicts.yaml'), 'kind: exit/spec-conflicts\nentries: []\n'); // design 站的出口条件：没矛盾就空（skills D15）
      }
      if (stage === 'check') {
        await p.write(c('ledgers/review-findings.yaml'), 'kind: review-findings\nentries: []\n');
        await p.write(c('ledgers/constitution-reply.yaml'), 'kind: constitution-reply\nentries:\n  - id: 不做无测试的行为变更\n    conclusion: complies\n    refs: [x]\n');
        await p.xforge('run');
        const ap = await p.xforge('attest', 'approve', '--stage', 'check', '--decision', 'approved');
        expect(ap.exit, JSON.stringify(ap.env)).toBe(0);
        expect(Object.keys(ap.env.result as object)).toEqual(['event']); // CLI-12
      }
      const a = await p.xforge('advance');
      expect(a.exit, `${stage}: ${JSON.stringify(a.env)}`).toBe(0);
    }
    expect(await stageNow()).toBe('apply');
    const d = await p.xforge('advance', 'package', 'P-01', '--dispatch');
    expectOk(d, 'dispatch');
    const execution = (d.env.result as { execution: string }).execution;
    await p.write('src/core/a.js', 'x\n');
    await p.write('src/other/b.js', 'y\n');
    await p.xforge('run', '--package', 'P-01');
    // 交付即集成：登记时查集成前置。先给一份声明了包外路径的交付记录（src/other/b.js 不在 src/core/**）：拒绝，且链与 receipt 一字不动。
    await p.write(c('ledgers/deliveries/P-01.yaml'), `kind: delivery\nentries:\n  - id: ${execution}\n    package: P-01\n    baseline_commit: ${p.head()}\n    paths_changed: [src/core/a.js, src/other/b.js]\n    conclusion: succeeded\n    refs: []\n    criteria: []\n    remaining: []\n    signer: ${execution}\n    at: ${AT}\n`);
    const chainBefore = readFileSync(join(p.root, 'xforge', '.audit', 'chain.jsonl'), 'utf8');
    const receiptsBefore = readdirSync(abs('evidence/receipts')).length;
    const refused = await p.xforge('advance', 'package', 'P-01', '--deliver');
    expect(refused.exit).toBe(1);
    expect(refused.env.diagnostics[0]?.code).toMatch(/^XF-ADVANCE-/);
    expect(readFileSync(join(p.root, 'xforge', '.audit', 'chain.jsonl'), 'utf8')).toBe(chainBefore);
    expect(readdirSync(abs('evidence/receipts')).length).toBe(receiptsBefore);
    await p.write(c('ledgers/deliveries/P-01.yaml'), `kind: delivery\nentries:\n  - id: ${execution}\n    package: P-01\n    baseline_commit: ${p.head()}\n    paths_changed: [src/core/a.js]\n    conclusion: succeeded\n    refs: []\n    criteria: []\n    remaining: []\n    signer: ${execution}\n    at: ${AT}\n`);
    const ok = await p.xforge('advance', 'package', 'P-01', '--deliver');
    expectOk(ok, 'advance, package, P-01, --deliver');
    expect((ok.env.result as { to: string }).to).toBe('integrated');
  });

  it('CLI-08 CLI-04 corruption of each record family is reported with its own code and exit 3; a transaction residue is named', async () => {
    const receiptsDir = abs('evidence/receipts');
    const first = join(receiptsDir, readdirSync(receiptsDir).sort()[0]!);
    const original = readFileSync(first, 'utf8');
    writeFileSync(first, original.replace(/^to: (\S+)$/m, 'to: tampered'));
    const r1 = await p.xforge('inspect');
    expect(r1.exit).toBe(3);
    expect(r1.env.diagnostics.map((d) => d.code)).toContain('XF-INSPECT-001');
    writeFileSync(first, original);

    const chainPath = join(p.root, 'xforge', '.audit', 'chain.jsonl');
    const chain = readFileSync(chainPath, 'utf8');
    const lines = chain.trim().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    writeFileSync(chainPath, lines.slice(1).join('\n') + '\n'); // 删掉第一行：后面的 prev 与 seq 都对不上了
    const r2 = await p.xforge('inspect');
    expect(r2.exit).toBe(3);
    expect(r2.env.diagnostics.some((d) => d.code === 'XF-INSPECT-004' && d.severity === 'blocking')).toBe(true);
    writeFileSync(chainPath, chain);

    // 署名：先由本人登记（合法），再把台账里的署名改成别人 —— 有事件而对不上，是损坏。
    const findings = abs('ledgers/review-findings.yaml');
    const signed = `kind: review-findings\nentries:\n  - id: F-001\n    conclusion: resolved\n    refs: [x]\n    signer: "${SIGNER}"\n    at: ${AT}\n`;
    writeFileSync(findings, signed);
    const unattested = await p.xforge('inspect');
    expect(unattested.exit, JSON.stringify(unattested.env)).toBe(0); // 还没登记：提示，不是损坏
    expect(unattested.env.diagnostics.some((d) => d.code === 'XF-INSPECT-003' && d.severity === 'warning')).toBe(true);
    expectOk(await p.xforge('attest', 'entry', 'review-findings', 'F-001'), 'attest entry');
    expect((await p.xforge('inspect')).exit).toBe(0);
    writeFileSync(findings, signed.replace(SIGNER, 'Someone Else <else@example.com>'));
    const r3 = await p.xforge('inspect');
    expect(r3.exit).toBe(3);
    expect(r3.env.diagnostics.some((d) => d.code === 'XF-INSPECT-003' && d.severity === 'blocking')).toBe(true);
    writeFileSync(findings, signed);

    mkdirSync(join(p.root, 'xforge', '.tx'), { recursive: true });
    writeFileSync(join(p.root, 'xforge', '.tx', 'dead-1.json'), '{}\n');
    const r4 = await p.xforge('inspect');
    expect(r4.env.diagnostics.find((d) => d.code === 'XF-INSPECT-006')?.remedy?.text).toContain('.tx');
    const clean = await (await import('node:fs/promises')).rm(join(p.root, 'xforge', '.tx'), { recursive: true, force: true });
    expect(clean).toBeUndefined();
    expectOk(await p.xforge('inspect'), "inspect");
  });

  it('CLI-25 explain works outside any project, for every dictionary file', async () => {
    const outside = new Project(tmpdir());
    const codes = readdirSync(join(repoRoot, 'diagnostics')).filter((f) => f.endsWith('.yaml'));
    expect(codes.length).toBeGreaterThan(30);
    for (const f of codes) expect((await outside.xforge('explain', f.slice(0, -5))).exit, f).toBe(0);
  });

  it('CLI-21 enforcement is a pure function of its payload', async () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'cat xforge/manifest.yaml' }, cwd: p.root };
    expect(await p.enforce(payload)).toEqual(await p.enforce(payload));
  });

  it('CLI-17 an archive that fails mid-merge leaves baseline, indexes, receipts and audit index untouched', async () => {
    // 把包做完、签收据、批终局，然后让基线目录不可写，归档必须整体回滚。
    await p.write(c('ledgers/deliveries/P-01.yaml'), `kind: delivery\nentries:\n  - id: ${(parse(readFileSync(join(abs('evidence/receipts'), readdirSync(abs('evidence/receipts')).find((f) => f.includes('dispatch'))!), 'utf8')) as { execution: string }).execution}\n    package: P-01\n    baseline_commit: ${p.head()}\n    paths_changed: [src/core/a.js]\n    conclusion: succeeded\n    refs: []\n    criteria: []\n    remaining: []\n    signer: ${(parse(readFileSync(join(abs('evidence/receipts'), readdirSync(abs('evidence/receipts')).find((f) => f.includes('dispatch'))!), 'utf8')) as { execution: string }).execution}\n    at: ${AT}\n`);
    await (await import('node:fs/promises')).rm(join(p.root, 'src', 'other'), { recursive: true, force: true });
    await p.xforge('run', '--package', 'P-01', '--force');
    expectOk(await p.xforge('advance'), "advance"); // apply → verify
    await p.write(c('assurance.md'), '# a\n\n## 连贯性\nx\n## 覆盖\n<!-- xforge:entries:begin kind=coverage -->\n| REQ-orders-create-001 | t |\n<!-- xforge:entries:end -->\n');
    await p.xforge('run');
    const gates = ['structure', 'ledgers', 'unit-tests', 'spec-delta'];
    await p.write(c('ledgers/verification-receipt.yaml'), `kind: verification-receipt\nentries:\n${gates.map((g) => `  - id: ${g}\n    conclusion: passed\n    refs: [x]\n    signer: "${SIGNER}"\n    at: ${AT}\n`).join('')}`);
    await p.xforge('run');
    expectOk(await p.xforge('attest', 'receipt'), "attest, receipt");
    expectOk(await p.xforge('advance'), "advance"); // verify → ready-to-archive
    expectOk(await p.xforge('attest', 'approve', '--archive', '--decision', 'approved'), "attest, approve, --archive, --decision, approved");
    const specsDir = join(p.root, 'xforge', 'specs');
    const snapshot = (dir: string): string => readdirSync(dir, { recursive: true }).join('|');
    const before = { specs: snapshot(specsDir), receipts: readdirSync(abs('evidence/receipts')).length, index: readFileSync(abs('evidence/audit-index.yaml'), 'utf8') };
    chmodSync(specsDir, 0o500); // 合并要在这里建 orders/ 并重写索引：写不进去，事务必须整体回滚
    try {
      const ar = await p.xforge('advance', '--archive');
      expect(ar.exit).not.toBe(0);
    } finally {
      chmodSync(specsDir, 0o755);
    }
    expect(snapshot(specsDir)).toBe(before.specs);
    expect(readdirSync(abs('evidence/receipts')).length).toBe(before.receipts);
    expect(readFileSync(abs('evidence/audit-index.yaml'), 'utf8')).toBe(before.index);
    expect((await p.xforge('state')).env.result).toMatchObject({ position: { status: 'ready-to-archive' } });
    expectOk(await p.xforge('advance', '--archive'), "advance, --archive");
  });
});

describe('记录读不出来是发现，不是崩溃（CLI-56）', () => {
  it('审计链有一行坏 JSON：inspect 报 XF-INSPECT-001，退出 3，不是裸栈', async () => {
    const p = await Project.create('badchain');
    await p.xforge('init', '--flow', 'quick');
    await p.xforge('attest', 'verification', '--command', 'unit-tests=echo ran');
    const chain = join(p.root, 'xforge', '.audit', 'chain.jsonl');
    appendFileSync(chain, 'this is not json\n'); // 一次写到一半被杀就长这样
    const r = await p.xforge('inspect', '--all');
    expect(r.stderr).not.toContain('内部错误');
    expect(r.exit).toBe(3);
    expect(r.env.diagnostics.map((d) => d.code)).toContain('XF-INSPECT-001');
  });

  it('受管文件的本地化区标记不成对：doctor 报 015，退出 1，不是裸栈', async () => {
    const p = await Project.create('badzone');
    await p.xforge('init', '--flow', 'quick');
    const skill = join(p.root, 'xforge', 'scaffold', 'skills', 'xforge', 'SKILL_cn.md');
    appendFileSync(skill, '\n<!-- xforge:local:begin -->\n人写的\n'); // 只有 begin
    const r = await p.xforge('doctor');
    expect(r.stderr).not.toContain('内部错误');
    expect(r.exit).toBe(1);
    const found = r.env.diagnostics.find((d) => d.code === 'XF-ASSEMBLE-015' && d.message.includes('标记不成对'));
    expect(found?.severity).toBe('blocking');
  });

  it('诊断里的路径是项目根相对，不漏机器上的目录结构', async () => {
    const p = await Project.create('abspath');
    await p.xforge('init', '--flow', 'quick');
    writeFileSync(join(p.root, 'xforge', 'manifest.yaml'), 'x: [[[\n');
    const r = await p.xforge('doctor');
    expect(r.env.diagnostics[0]?.message).toContain('xforge/manifest.yaml');
    expect(r.env.diagnostics[0]?.message).not.toContain(p.root);
  });
});

describe('spawn 出去的进程拿不到 XFORGE_*（CLI-55）', () => {
  it('门命令看不见审计密钥 —— 看得见就等于防伪失效', async () => {
    const p = await Project.create('gateenv');
    await p.xforge('init', '--flow', 'quick');
    await p.xforge('attest', 'verification', '--command', 'unit-tests=env | grep -c XFORGE_ || true');
    const head = p.commit('seed'); // baseline_commit 要是一个真的 sha
    await p.write('xforge/changes/C-20260918-env/change.yaml', `id: C-20260918-env\ntitle: t\nflow: quick\nrisk: low\nimpact: []\nbaseline_commit: ${head}\n`);
    const r = await p.xforgeIn({ env: { XFORGE_AUDIT_HMAC: 'secret-must-not-leak' } }, 'run', '--gate', 'unit-tests', '--force');
    const gates = (r.env.result as { gates: Array<{ log?: string }> }).gates;
    const log = gates[0]?.log ? readFileSync(join(p.root, gates[0].log), 'utf8') : '';
    expect(log.trim()).toBe('0'); // 一个 XFORGE_* 都没有
    expect(log).not.toContain('secret-must-not-leak');
  });
});
