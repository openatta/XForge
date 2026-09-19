// design: cli §2.4 — CLI-34：MCP 审批与人批同形（同一种事件、同样计数、同样绑修订），只是方法不同；CLI-35：MCP 不可用时审批保持缺失，不算否决。
// RF-36：清单只配 MCP 服务；请求带项目 git 地址、Change、站、修订、请求者的 git 身份；事件记 via / requested_by / evidence。
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { Project, repoRoot, type Result } from '../helpers/project.js';

const CHANGE = 'C-20260918-mcp';
const SIGNER = 'Test User <test@example.com>';
const AT = '2026-09-15T10:00:00Z';
const FAKE = join(repoRoot, 'test', 'helpers', 'fake-mcp.mjs');
const code = (r: Result): string | undefined => r.env.diagnostics[0]?.code;
const blockers = (r: Result): string[] => ((r.env.result as { blockers?: Array<{ token: string }> }).blockers ?? []).map((b) => b.token);

describe('MCP approval', () => {
  let p: Project;
  let logFile = '';
  const c = (rel: string): string => `xforge/changes/${CHANGE}/${rel}`;
  const manifestPath = (): string => join(p.root, 'xforge', 'manifest.yaml');
  const setApprover = (env: Record<string, string>, timeout = 30): void => {
    const m = parse(readFileSync(manifestPath(), 'utf8')) as Record<string, unknown>;
    m['mcp_approvers'] = [{ id: 'reviewer', server: { command: process.execPath, args: [FAKE], env: { FAKE_MCP_LOG: logFile, ...env } }, timeout_seconds: timeout }];
    // 清单是治理文件：这里模拟人手改。
    writeFileSync(manifestPath(), stringify(m));
  };
  const setAllow = (allow: string[]): void => {
    const path = join(p.root, 'xforge', 'scaffold', 'flows', 'quick.yaml');
    const flow = parse(readFileSync(path, 'utf8')) as { approval_policies: Record<string, Record<string, unknown>> };
    flow.approval_policies['final']!['allow'] = allow;
    writeFileSync(path, stringify(flow));
  };

  beforeAll(async () => {
    p = await Project.create('mcp');
    logFile = join(p.root, 'mcp-requests.log');
    await p.write('package.json', '{"name":"mcp","version":"0.0.0"}\n');
    await p.write('test.js', 'process.exit(0);\n');
    p.commit('seed');
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/acme/mcp.git'], { cwd: p.root });
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude');
    p.commit('init');
    await p.xforge('attest', 'verification', '--command', 'unit-tests=node test.js');
    await p.write(c('change.yaml'), `id: ${CHANGE}\ntitle: mcp\nflow: quick\nrisk: low\nimpact: []\nbaseline_commit: ${p.head()}\n`);
    await p.write(c('proposal.md'), '# mcp\n\n## 背景\nx\n## 目标\ny\n## 非目标\nz\n## 为什么选这条流程\nlow\n## 影响面\nnone\n');
    await p.write(c('scope.yaml'), 'scheme: default\npaths: ["src/**"]\n');
    await p.write(c('work-packages.yaml'), 'packages:\n  - id: P-01\n    title: one\n    depends_on: []\n    paths: ["src/**"]\n    verify: {gate: unit-tests}\n    criteria: [{id: C-1, text: "works"}]\n    review: none\n');
    await p.write(c('ledgers/exit/spec-conflicts.yaml'), 'kind: exit/spec-conflicts\nentries: []\n'); // design 站的出口条件：没矛盾就空（skills D15）
    expect((await p.xforge('advance')).exit).toBe(0);
    const d = await p.xforge('advance', 'package', 'P-01', '--dispatch');
    const execution = (d.env.result as { execution: string }).execution;
    await p.write('src/one.js', 'module.exports = 1;\n');
    expect((await p.xforge('run', '--package', 'P-01')).exit).toBe(0);
    await p.write(c('ledgers/deliveries/P-01.yaml'), `kind: delivery\nentries:\n  - id: ${execution}\n    package: P-01\n    baseline_commit: ${p.head()}\n    paths_changed: [src/one.js]\n    revision: ${'a'.repeat(64)}\n    conclusion: succeeded\n    refs: [evidence/gates/unit-tests/1.yaml]\n    criteria: [{id: C-1, evidence: "test.js"}]\n    remaining: []\n    signer: ${execution}\n    at: ${AT}\n`);
    expect((await p.xforge('advance', 'package', 'P-01', '--deliver')).exit).toBe(0);
    expect((await p.xforge('advance')).exit).toBe(0);
    await p.write(c('ledgers/verification-receipt.yaml'), `kind: verification-receipt\nentries:\n  - id: unit-tests\n    conclusion: passed\n    refs: [evidence/gates/unit-tests/1.yaml]\n    signer: "${SIGNER}"\n    at: ${AT}\n`);
    expect((await p.xforge('attest', 'receipt')).exit).toBe(0);
    const a = await p.xforge('advance');
    expect((a.env.result as { to: string }).to).toBe('ready-to-archive');
  });

  it('XF-ATTEST-002 --via names an approver the manifest does not configure', async () => {
    const r = await p.xforge('attest', 'approve', '--archive', '--via', 'reviewer');
    expect(r.exit).toBe(1);
    expect(code(r)).toBe('XF-ATTEST-002');
    expect(blockers(await p.xforge('state'))).toContain('approval-missing');
  });

  it('once configured, the remedy names the MCP approver and still offers the human form', async () => {
    setApprover({});
    const s = await p.xforge('state');
    const b = ((s.env.result as { blockers: Array<{ token: string; remedy: { command?: string; text: string } }> }).blockers).find((x) => x.token === 'approval-missing')!;
    expect(b.remedy.command).toBe('xforge attest approve --archive --via reviewer');
    expect(b.remedy.text).toContain('--decision approved');
  });

  it('CLI-35 a silent, broken or malformed MCP leaves the approval missing (XF-ATTEST-004), never rejected', async () => {
    for (const mode of ['silent', 'error', 'garbage']) {
      setApprover({ FAKE_MCP_MODE: mode }, mode === 'silent' ? 1 : 30);
      const r = await p.xforge('attest', 'approve', '--archive', '--via', 'reviewer');
      expect(r.exit, mode).toBe(1);
      expect(code(r), mode).toBe('XF-ATTEST-004');
      expect(blockers(await p.xforge('state')), mode).toContain('approval-missing');
    }
    const chain = readFileSync(join(p.root, 'xforge', '.audit', 'chain.jsonl'), 'utf8');
    expect(chain.includes('approval.decided')).toBe(false);
  });

  it('a rejection from the MCP is recorded like a human rejection', async () => {
    setApprover({ FAKE_MCP_DECISION: 'rejected' });
    const r = await p.xforge('attest', 'approve', '--archive', '--via', 'reviewer');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(r.env.result).toMatchObject({ via: 'mcp:reviewer', approver: 'review-bot', decision: 'rejected' });
    expect(blockers(await p.xforge('state'))).toContain('approval-rejected');
  });

  it('CLI-34 RF-36 an MCP approval is the same event as a human one, with via / requested_by / evidence, and the request said where it came from', async () => {
    if (existsSync(logFile)) rmSync(logFile);
    setApprover({});
    const r = await p.xforge('attest', 'approve', '--archive', '--via', 'reviewer');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    const events = readFileSync(join(p.root, 'xforge', '.audit', 'chain.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ kind: 'approval.decided', decision: 'approved', via: 'mcp:reviewer', requested_by: SIGNER, actor: { name: 'review-bot', email: 'review-bot@reviewer.mcp' } });
    expect(String(last['evidence'])).toMatch(/^[0-9a-f]{64}$/);
    expect((last['subject'] as { archive: boolean; revision: string }).revision).toMatch(/^[0-9a-f]{64}$/);
    const request = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').at(-1)!) as { name: string; arguments: Record<string, unknown> };
    expect(request.name).toBe('approve');
    expect(request.arguments).toMatchObject({ project: { git_url: 'https://example.com/acme/mcp.git' }, change: CHANGE, scheme: 'default', flow: 'quick', archive: true, requested_by: SIGNER });
    expect(String(request.arguments['revision'])).toMatch(/^[0-9a-f]{64}$/);
    expect(blockers(await p.xforge('state'))).not.toContain('approval-missing');
    // 链完整：inspect 认这条事件。
    expect((await p.xforge('inspect')).exit).toBe(0);
  });

  it('XF-ATTEST-003 the policy decides who may approve: allow: [mcp] refuses a person, allow: [human] refuses --via', async () => {
    setAllow(['mcp']);
    const human = await p.xforge('attest', 'approve', '--archive', '--decision', 'approved');
    expect(human.exit).toBe(1);
    expect(code(human)).toBe('XF-ATTEST-003');
    const s = await p.xforge('state');
    const remedy = ((s.env.result as { blockers: Array<{ token: string; remedy: { command?: string; text: string } }> }).blockers).find((x) => x.token === 'approval-missing' || x.token === 'approval-stale');
    if (remedy) expect(remedy.remedy.text).not.toContain('--decision approved');
    setAllow(['human']);
    const via = await p.xforge('attest', 'approve', '--archive', '--via', 'reviewer');
    expect(via.exit).toBe(1);
    expect(code(via)).toBe('XF-ATTEST-003');
    setAllow(['human', 'mcp']);
  });

  it('the approved change archives; the MCP event is on the receipt', async () => {
    const done = await p.xforge('advance', '--archive');
    expect(done.exit, JSON.stringify(done.env)).toBe(0);
    expect((done.env.result as { to: string }).to).toBe('archived');
  });
});
