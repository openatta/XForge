// design: cli §7.3 — major：多一站 clarify（出口条件台账，attest entry exit/…），站级审批 separation_of_duties。
import { beforeAll, describe, expect, it } from 'vitest';
import { Project } from '../helpers/project.js';

const CHANGE = 'C-20260915-credential-store';
const SIGNER = 'Test User <test@example.com>';
const AT = '2026-09-15T10:00:00Z';

describe('major walkthrough (through check)', () => {
  let p: Project;
  const c = (rel: string): string => `xforge/changes/${CHANGE}/${rel}`;

  beforeAll(async () => {
    p = await Project.create('major');
    await p.write('package.json', '{"name":"cred","version":"0.0.0"}\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'major');
    p.commit('init');
  });

  it('propose refuses a risk the flow does not accept, then accepts high', async () => {
    await p.write(c('change.yaml'), `id: ${CHANGE}\ntitle: 凭据库\nflow: quick\nrisk: high\nimpact: [security, data-migration]\nbaseline_commit: ${p.head()}\n`);
    const bad = await p.xforge('state');
    expect(bad.exit).toBe(1);
    expect(bad.env.diagnostics[0]?.code).toBe('XF-STATE-004');
    await p.write(c('change.yaml'), `id: ${CHANGE}\ntitle: 凭据库\nflow: major\nrisk: high\nimpact: [security, data-migration]\nbaseline_commit: ${p.head()}\n`);
    await p.write(c('proposal.md'), '# 凭据库\n\n## 背景\nb\n## 目标\ng\n## 非目标\nn\n## 为什么选这条流程\nhigh\n## 影响面\nsecurity\n');
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('clarify');
  });

  it('clarify: material questions are an exit-condition ledger, each answer signed', async () => {
    const s = await p.xforge('state', '--orient');
    const stage = (s.env.result as { orient: { stage: { id: string; isolate: boolean; ledgers: Array<{ kind: string; draft?: string }> } } }).orient.stage;
    expect(stage.id).toBe('clarify');
    expect(stage.isolate).toBe(false);
    expect(stage.ledgers[0]).toMatchObject({ kind: 'exit/material-questions' });
    expect(stage.ledgers[0]!.draft).toContain('kind: exit/material-questions');
    expect(stage.ledgers[0]!.draft).toContain('Q-001');
    await p.write(c('ledgers/exit/material-questions.yaml'), `kind: exit/material-questions\nentries:\n  - id: Q-001\n    conclusion: answered\n    refs: [proposal.md#目标]\n    signer: "${SIGNER}"\n    at: ${AT}\n    note: 默认答案被接受\n`);
    const blocked = await p.xforge('advance');
    expect(blocked.exit).toBe(1);
    expect(((blocked.env.result as { blockers: Array<{ token: string; ref: string }> }).blockers)[0]).toMatchObject({ token: 'attest-missing', ref: 'exit/material-questions#Q-001' });
    expect((await p.xforge('attest', 'entry', 'exit/material-questions', 'Q-001')).exit).toBe(0);
    // clarify 出站要审批（Change 级，方案共享）。
    const needsApproval = await p.xforge('advance');
    expect(needsApproval.exit).toBe(1);
    expect(((needsApproval.env.result as { blockers: Array<{ token: string }> }).blockers).map((b) => b.token)).toContain('approval-missing');
    expect((await p.xforge('attest', 'approve', '--stage', 'clarify', '--decision', 'approved')).exit).toBe(0);
    const a = await p.xforge('advance');
    expect(a.exit, JSON.stringify(a.env)).toBe(0);
    expect((a.env.result as { to: string }).to).toBe('design');
  });

  it('rework goes back only to a declared stage and records the receipt', async () => {
    const bad = await p.xforge('advance', '--rework-to', 'clarify', '--reason', 'x');
    expect(bad.exit).toBe(1);
    expect(bad.env.diagnostics[0]?.code).toBe('XF-ADVANCE-002');
    const ok = await p.xforge('advance', '--rework-to', 'propose', '--reason', '规格矛盾');
    expect(ok.exit, JSON.stringify(ok.env)).toBe(0);
    expect((ok.env.result as { to: string; receipt: string }).to).toBe('propose');
    const receipts = await p.xforge('show', 'receipts');
    const list = (receipts.env.result as { content: Array<{ kind: string; from: string; to: string }> }).content;
    expect(list.map((r) => r.kind)).toEqual(['stage-transition', 'stage-transition', 'rework']);
    // 回到 propose 后再走一遍到 design：clarify 的台账仍在，署名事件仍匹配（digest 未变）。
    expect((await p.xforge('advance')).exit).toBe(0);
    const again = await p.xforge('advance');
    expect(again.exit, JSON.stringify(again.env)).toBe(0);
    expect((again.env.result as { to: string }).to).toBe('design');
  });

  it('inspect on the walked change is clean', async () => {
    const i = await p.xforge('inspect');
    expect(i.exit, JSON.stringify(i.env)).toBe(0);
  });
});
