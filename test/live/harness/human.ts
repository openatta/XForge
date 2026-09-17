// design: live-test §0 — D4：人由 harness 扮演，只看 xforge state 的 blockers；一律批准、需署名一律署名、材料问题取默认答案。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Ledger } from '../../../src/model/types.js';
import { HARNESS_IDENTITY } from './setup.js';
import { xforge } from './xforge.js';

export interface Blocker {
  token: string;
  ref: string;
  verb: string;
  remedy: { command?: string; text: string };
}

export interface HumanAction {
  action: string;
  ok: boolean;
  detail?: string | undefined;
}

const SIGNER = `${HARNESS_IDENTITY.name} <${HARNESS_IDENTITY.email}>`;
const AT = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function ledgerFile(project: string, changeId: string, ref: string): string {
  const rel = ref.startsWith('exit/') ? `ledgers/exit/${ref.slice(5)}.yaml` : `ledgers/${ref}.yaml`;
  return join(project, 'xforge', 'changes', changeId, rel);
}

/** 给需要人负责的条目署名；open 的发现按 policy 处理。返回改了哪些条目。 */
function signLedger(path: string, ref: string, resolveOpen: boolean): string[] {
  const ledger = parse(readFileSync(path, 'utf8')) as Ledger;
  const touched: string[] = [];
  for (const e of ledger.entries) {
    let needs = false;
    if (ref === 'review-findings') {
      if (e.conclusion === 'open' && resolveOpen) {
        e.conclusion = 'resolved';
        e.note = `${e.note ? e.note + ' ' : ''}[harness] 已核对，接受。`;
      }
      needs = e.conclusion === 'resolved' || e.conclusion === 'rejected';
    } else if (ref === 'constitution-reply') needs = e.conclusion === 'violates';
    else if (ref === 'verification-receipt' || ref.startsWith('exit/')) needs = true;
    if (!needs) continue;
    if (e.signer !== SIGNER || !e.at) {
      e.signer = SIGNER;
      e.at = AT();
      touched.push(e.id);
    }
  }
  writeFileSync(path, stringify(ledger, { lineWidth: 0 }));
  return touched;
}

export interface HumanContext {
  project: string;
  changeId: string;
  /** solid-rework：check 站有 open 发现且设计仍含植入句 → 返工到 design。 */
  plantedSentence?: string;
  reworked: boolean;
  /** 控制面报的包状态；执行者把包交付成 blocked 时，人裁决退回 design 调整计划。 */
  packages?: Array<{ id: string; state: string }>;
  /** mcp：审批留给清单里的 MCP 审批者（模型跑 --via），人不批。 */
  approver?: 'human' | 'mcp';
}

export async function actAsHuman(ctx: HumanContext, blockers: Blocker[], stage: string | null): Promise<HumanAction[]> {
  const actions: HumanAction[] = [];
  const signed = new Set<string>();
  // 门没跑或过期时，签收据必然被拒（XF-ADVANCE-003）：那是模型的活，人先不动。
  const gatesNotCurrent = blockers.some((b) => b.token === 'gate-stale' || b.token === 'gate-missing' || b.token === 'gate-failed');

  // 返工判定先于一切署名：设计还带着植入句时，不能把发现标成 resolved。
  const openFindings = blockers.filter((b) => b.token === 'ledger-open' && b.ref === 'review-findings');
  // 最多返工一次：第二遍 check 无论如何都由人把发现定了，避免设计里残留植入句时无限返工。
  if (openFindings.length && ctx.plantedSentence && stage === 'check' && !ctx.reworked) {
    const design = readFileSync(join(ctx.project, 'xforge', 'changes', ctx.changeId, 'design.md'), 'utf8');
    if (design.includes(ctx.plantedSentence)) {
      const r = await xforge(ctx.project, ['advance', '--rework-to', 'design', '--reason', '设计与验收套件矛盾：部分收款不应标记 paid']);
      actions.push({ action: 'rework-to design', ok: r.exit === 0, detail: JSON.stringify(r.env.diagnostics) });
      ctx.reworked = true;
      return actions;
    }
  }

  // apply 站里有包被执行者交付成 blocked：它在说「计划要改」，人裁决退回 design（最多一次）。
  const gateFailed = blockers.find((b) => b.token.startsWith('package-gate-failed:'));
  const blockedPkg = (ctx.packages ?? []).find((p) => p.state === 'blocked') ?? (gateFailed ? { id: gateFailed.ref, state: 'gate-failed' } : undefined);
  if (blockedPkg && stage === 'apply' && !ctx.reworked) {
    const reason = blockedReason(ctx.project, ctx.changeId, blockedPkg.id);
    const r = await xforge(ctx.project, ['advance', '--rework-to', 'design', '--reason', reason]);
    actions.push({ action: `rework-to design (package ${blockedPkg.id} blocked)`, ok: r.exit === 0, detail: r.exit === 0 ? reason.slice(0, 160) : JSON.stringify(r.env.diagnostics) });
    ctx.reworked = true;
    return actions;
  }

  for (const b of blockers) {
    if (b.token === 'ledger-open' && b.ref === 'review-findings') {
      const path = ledgerFile(ctx.project, ctx.changeId, b.ref);
      signLedger(path, b.ref, true);
      actions.push({ action: 'resolve open findings', ok: true });
      continue;
    }
    if (b.token === 'attest-missing') {
      const [ref, entryId] = b.ref.split('#');
      if (!ref) continue;
      const path = ledgerFile(ctx.project, ctx.changeId, ref);
      if (!signed.has(ref)) {
        signLedger(path, ref, true);
        signed.add(ref);
      }
      if (ref === 'verification-receipt' && gatesNotCurrent) {
        actions.push({ action: 'attest receipt', ok: true, detail: '门未当前，跳过；等模型重跑' });
        continue;
      }
      const r = ref === 'verification-receipt' ? await xforge(ctx.project, ['attest', 'receipt']) : await xforge(ctx.project, ['attest', 'entry', ref, entryId ?? '']);
      actions.push({ action: `attest ${ref}${entryId ? '#' + entryId : ''}`, ok: r.exit === 0, detail: r.exit === 0 ? undefined : JSON.stringify(r.env.diagnostics) });
      continue;
    }
    if ((b.token === 'approval-missing' || b.token === 'approval-rejected' || b.token === 'approval-stale') && ctx.approver !== 'mcp') {
      const args = stage ? ['attest', 'approve', '--stage', stage, '--decision', 'approved', '--note', 'harness: approved'] : ['attest', 'approve', '--archive', '--decision', 'approved', '--note', 'harness: approved'];
      const r = await xforge(ctx.project, args);
      actions.push({ action: args.slice(0, 4).join(' '), ok: r.exit === 0, detail: r.exit === 0 ? undefined : JSON.stringify(r.env.diagnostics) });
      continue;
    }
  }
  return actions;
}

/** 交付记录里执行者写的 remaining，作为返工理由。 */
function blockedReason(project: string, changeId: string, pkg: string): string {
  try {
    const ledger = parse(readFileSync(join(project, 'xforge', 'changes', changeId, 'ledgers', 'deliveries', `${pkg}.yaml`), 'utf8')) as Ledger;
    const last = ledger.entries.at(-1);
    const remaining = (last?.remaining ?? []).join(' ');
    return remaining ? `包 ${pkg} 受阻：${remaining}`.slice(0, 500) : `包 ${pkg} 受阻，执行者要求调整计划`;
  } catch {
    return `包 ${pkg} 受阻，执行者要求调整计划`;
  }
}
