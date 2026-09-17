// design: cli §2.1 — 读：我在哪、欠什么、什么挡着；--orient 追加 0a 与 1 级并按 0a → 1 → 0b 排。
import type { Outcome } from '../cli/envelope.js';
import { newChangeId } from '../model/ids.js';
import { READY_TO_ARCHIVE } from '../model/flow.js';
import { evaluateArchiveExit, evaluateExit, type Blocker } from './exit.js';
import { currentStage, listSchemes, loadChange, loadFlow, owedItems, type ChangeCtx, type OwedItem, type Project } from './context.js';
import { invariants, ledgerDraft, stageSlice, type Invariants, type StageSlice } from './slice.js';

export interface StateResult {
  orient?: { invariants: Invariants; stage: StageSlice | null };
  position: { stage: string | null; status: string; rework?: { from: string; reason: string; receipt: string } };
  owed: OwedItem[];
  blockers: Blocker[];
  packages: Array<{ id: string; state: string }>;
  drafts: Record<string, string>;
  /** 这个 Change 有哪些实现方案；单方案项目恒为 ['default']。 */
  schemes?: string[];
}

export async function runState(project: Project, opts: { change?: string; orient: boolean; scheme?: string }): Promise<Outcome<StateResult>> {
  const ctx = await loadChange(project, opts.change, opts.scheme);
  if (!ctx) return noChange(project, opts.orient);
  const stage = currentStage(ctx);
  const owed = stage ? await owedItems(ctx, stage) : [];
  const blockers = stage ? await evaluateExit(ctx, stage) : ctx.position.status === 'ready-to-archive' ? await evaluateArchiveExit(ctx) : [];
  const drafts: Record<string, string> = {};
  for (const o of owed) if (o.kind === 'ledger' && o.status === 'pending' && !o.id.startsWith('delivery:')) drafts[o.id] = ledgerDraft(o.id);
  const lastMove = [...ctx.receipts].reverse().find((r) => r.kind === 'stage-transition' || r.kind === 'rework');
  const position: StateResult['position'] = { stage: ctx.position.stage ?? (ctx.position.status === 'ready-to-archive' ? READY_TO_ARCHIVE : null), status: ctx.position.status };
  if (lastMove?.kind === 'rework' && stage && lastMove.to === stage.id) position.rework = { from: lastMove.from, reason: String(lastMove.subject['reason'] ?? ''), receipt: lastMove.id };
  const result: StateResult = {
    position,
    owed,
    blockers,
    packages: [...ctx.packages].map(([id, state]) => ({ id, state })),
    drafts,
  };
  const named = await listSchemes(ctx.change);
  if (named.length) result.schemes = ['default', ...named];
  if (opts.orient) {
    result.orient = { invariants: await invariants(project, ctx.flow, ctx), stage: stage ? await stageSlice(ctx, stage) : null };
    // 0a → 1 → 0b：orient 放在最前面，其余字段保持声明顺序。
  }
  const ordered: StateResult = opts.orient ? { orient: result.orient!, position: result.position, owed, blockers, packages: result.packages, drafts, ...(result.schemes ? { schemes: result.schemes } : {}) } : result;
  return { result: ordered, change: ctx.changeId, scheme: ctx.scheme, next: nextFor(ctx, blockers) };
}

function nextFor(ctx: ChangeCtx, blockers: Blocker[]): Array<{ command: string; why: string }> {
  if (ctx.position.status === 'archived') return [];
  if (!blockers.length) {
    return ctx.position.status === 'ready-to-archive'
      ? [{ command: 'xforge advance --archive', why: '终局条件已满足' }]
      : [{ command: 'xforge advance', why: '本站出口条件已满足' }];
  }
  return blockers.filter((b) => b.remedy.command).slice(0, 3).map((b) => ({ command: b.remedy.command!, why: b.token }));
}

async function noChange(project: Project, orient: boolean): Promise<Outcome<StateResult>> {
  const flow = await loadFlow(project, project.manifest.flow.default);
  const draft = [
    `id: ${newChangeId('slug')}   # 目录名必须与它相同；slug 换成这次改动的名字`,
    'title: <一句话>',
    `flow: ${flow.name}`,
    'risk: low            # low | medium | high',
    'impact: []           # interface | security | data-migration | infra',
    'baseline_commit: <当前 HEAD 的 sha>',
    '',
  ].join('\n');
  const result: StateResult = {
    position: { stage: null, status: 'no-change' },
    owed: [],
    blockers: [{ token: 'change-missing', ref: 'change.yaml', verb: 'write', remedy: { text: '写 xforge/changes/<id>/change.yaml，见 drafts.change' } }],
    packages: [],
    drafts: { change: draft },
  };
  if (orient) result.orient = { invariants: await invariants(project, flow, null), stage: null };
  const ordered: StateResult = orient ? { orient: result.orient!, position: result.position, owed: [], blockers: result.blockers, packages: [], drafts: result.drafts } : result;
  return { result: ordered, next: [{ command: 'xforge state --orient', why: '写完声明后取定向' }] };
}
