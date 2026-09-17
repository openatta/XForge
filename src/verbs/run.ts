// design: cli §2.3 — 产：跑门，把结果刻下来；通过的门给结论，失败的门才给正文。
import type { Outcome } from '../cli/envelope.js';
import { CliError } from '../cli/errors.js';
import { Transaction } from '../fs/transaction.js';
import { loadGate, runGate, type RunOutcome } from '../gates/index.js';
import type { EnvelopeDiagnostic, Stage } from '../model/types.js';
import { requireStage, type ChangeCtx } from './context.js';
import { evaluateExit, type Blocker } from './exit.js';

export interface RunOptions {
  gates?: string[];
  packageId?: string;
  force?: boolean;
}

export async function runRun(ctx: ChangeCtx, opts: RunOptions): Promise<Outcome<{ gates: RunOutcome[]; blockers: Blocker[] }>> {
  const stage = requireStage(ctx);
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  const outcomes = await runGates(ctx, stage, tx, opts);
  const changed = await tx.commit();
  const diagnostics = diagnosticsFor(outcomes);
  // 跑完门顺带把本站出口判一遍：读者不必再调一次 state 才知道还欠什么。
  const blockers = await evaluateExit(ctx, stage);
  const next = blockers.length ? blockers.filter((b) => b.remedy.command).slice(0, 3).map((b) => ({ command: b.remedy.command!, why: b.token })) : [{ command: 'xforge advance', why: '本站出口条件已满足' }];
  return { result: { gates: outcomes, blockers }, diagnostics, changed, change: ctx.changeId, scheme: ctx.scheme, next };
}

export async function runGates(ctx: ChangeCtx, stage: Stage, tx: Transaction, opts: RunOptions): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  if (opts.packageId) {
    const pkg = ctx.plan?.packages.find((p) => p.id === opts.packageId);
    if (!pkg) throw new CliError('XF-ADVANCE-001', `计划里没有包 ${opts.packageId}`, 1, { command: 'xforge state', text: '看计划' });
    const gate = await loadGate(ctx, pkg.verify.gate);
    outcomes.push(await runGate(ctx, gate, tx, { stage, packageId: pkg.id, packagePaths: pkg.paths, force: opts.force ?? false }));
    return outcomes;
  }
  const names = opts.gates?.length ? opts.gates : stage.gates;
  for (const name of names) {
    const gate = await loadGate(ctx, name);
    outcomes.push(await runGate(ctx, gate, tx, { stage, force: opts.force ?? false }));
  }
  return outcomes;
}

export function diagnosticsFor(outcomes: readonly RunOutcome[]): EnvelopeDiagnostic[] {
  const out: EnvelopeDiagnostic[] = [];
  for (const o of outcomes) {
    if (o.result !== 'failed') continue;
    const rejected = (o.accepted ?? []).filter((a) => a.verdict === 'rejected');
    if (rejected.length) {
      out.push({ code: 'XF-RUN-004', severity: 'blocking', message: `门 ${o.gate} 未受理台账：${rejected.map((r) => `${r.ledger}（${(r.reasons ?? []).join('；')}）`).join('，')}`, remedy: { text: '按 reasons 改台账，下一次 advance 跑门时再受理' } });
      continue;
    }
    out.push({ code: 'XF-RUN-003', severity: 'blocking', message: `门 ${o.gate} 失败${o.reasons?.length ? `：${o.reasons.join('；')}` : ''}`, remedy: { command: `xforge show gate:${o.gate}`, text: '读输出，修好后重跑' } });
  }
  return out;
}
