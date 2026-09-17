// design: rule-files §3.1 — 出口条件的六种 kind 各判什么，挡住时给哪个阻塞 token（cli §2.1 的 blockers）。
import picomatch from 'picomatch';
import { gitChangedPaths } from '../audit/identity.js';
import { readText } from '../fs/transaction.js';
import { gateStatus, loadGate, stageRevision } from '../gates/index.js';
import { findSigningEvent } from '../model/audit.js';
import { ledgerDigest } from '../model/digest.js';
import { auditKindFor, entriesNeedingSignature } from '../model/ledger.js';
import type { ExitCondition, Ledger, Stage } from '../model/types.js';
import { parseYaml } from '../model/yaml.js';
import { TERMINAL_PACKAGE_STATES } from '../machines/transitions.js';
import { workdirOf, type ChangeCtx } from './context.js';

export interface Blocker {
  token: string;
  ref: string;
  verb: 'write' | 'run' | 'attest' | 'advance' | 'inspect';
  remedy: { command?: string; text: string };
}

export async function evaluateExit(ctx: ChangeCtx, stage: Stage): Promise<Blocker[]> {
  const out: Blocker[] = ctx.problems.map((p) => ({ token: `artifact-invalid:${p.ref}`, ref: p.ref, verb: 'write' as const, remedy: { text: p.message } }));
  for (const cond of stage.exit) out.push(...(await evaluateCondition(ctx, stage, cond)));
  return out;
}

export async function evaluateArchiveExit(ctx: ChangeCtx): Promise<Blocker[]> {
  const out: Blocker[] = [];
  for (const cond of ctx.flow.archive.exit) out.push(...(await evaluateCondition(ctx, null, cond)));
  return out;
}

async function evaluateCondition(ctx: ChangeCtx, stage: Stage | null, cond: ExitCondition): Promise<Blocker[]> {
  switch (cond.kind) {
    case 'gate':
      return gateCondition(ctx, cond.ref);
    case 'ledger':
      return ledgerCondition(ctx, cond.ref, cond.requires);
    case 'attested':
      return attestedCondition(ctx, cond.ref);
    case 'approval':
      return await approvalCondition(ctx, stage, cond.policy);
    case 'packages':
      return await packagesCondition(ctx);
    case 'unclaimed-changes':
      return unclaimedCondition(ctx);
    default:
      return [];
  }
}

async function gateCondition(ctx: ChangeCtx, name: string): Promise<Blocker[]> {
  const gate = await loadGate(ctx, name);
  const { status } = await gateStatus(ctx, gate);
  if (status === 'current' || status === 'not-owed') return [];
  if (status === 'failed') return [{ token: 'gate-failed', ref: name, verb: 'run', remedy: { command: `xforge show gate:${name}`, text: '读这道门的输出，修好后重跑' } }];
  return [{ token: status === 'stale' ? 'gate-stale' : 'gate-missing', ref: name, verb: 'run', remedy: { command: `xforge run --gate ${name}`, text: '跑这道门；advance 默认捎带' } }];
}

async function readLedger(ctx: ChangeCtx, ref: string): Promise<{ ledger: Ledger; digest: string } | { missing: true } | { invalid: string }> {
  const text = await readText(ctx.change.ledger(ref));
  if (text === null) return { missing: true };
  try {
    return { ledger: parseYaml<Ledger>(text, 'ledger', ref), digest: ledgerDigest(text) };
  } catch (error) {
    return { invalid: (error as Error).message };
  }
}

async function ledgerCondition(ctx: ChangeCtx, ref: string, requires: 'exists' | 'all-resolved'): Promise<Blocker[]> {
  const r = await readLedger(ctx, ref);
  if ('missing' in r) return [{ token: 'ledger-missing', ref, verb: 'write', remedy: { text: `写 ledgers/${ref}.yaml；下一次 advance 跑门时受理` } }];
  if ('invalid' in r) return [{ token: 'ledger-invalid', ref, verb: 'write', remedy: { text: r.invalid } }];
  if (requires === 'all-resolved') {
    const open = r.ledger.entries.filter((e) => e.conclusion === 'open').map((e) => e.id);
    if (open.length) return [{ token: 'ledger-open', ref, verb: 'write', remedy: { text: `还有未决条目：${open.join('、')}` } }];
  }
  return [];
}

async function attestedCondition(ctx: ChangeCtx, ref: string): Promise<Blocker[]> {
  const r = await readLedger(ctx, ref);
  if ('missing' in r) return [{ token: 'ledger-missing', ref, verb: 'write', remedy: { text: `写 ledgers/${ref}.yaml` } }];
  if ('invalid' in r) return [{ token: 'ledger-invalid', ref, verb: 'write', remedy: { text: r.invalid } }];
  const kind = auditKindFor(ref);
  if (!kind) return [];
  const out: Blocker[] = [];
  for (const e of entriesNeedingSignature(r.ledger)) {
    const event = findSigningEvent(e, ctx.events, kind, r.digest);
    if (event) continue;
    const command = ref === 'verification-receipt' ? 'xforge attest receipt' : `xforge attest entry ${ref} ${e.id}`;
    out.push({ token: 'attest-missing', ref: `${ref}#${e.id}`, verb: 'attest', remedy: { command, text: '由署名的人登记；台账改过要重新登记' } });
  }
  return out;
}

async function approvalCondition(ctx: ChangeCtx, stage: Stage | null, policyName: string): Promise<Blocker[]> {
  const policy = ctx.flow.approval_policies[policyName];
  if (!policy) return [{ token: 'approval-policy-missing', ref: policyName, verb: 'inspect', remedy: { text: `流程里没有审批策略 ${policyName}` } }];
  const subjectMatches = (s: Record<string, unknown>): boolean => (stage ? s['stage'] === stage.id : s['archive'] === true);
  const all = ctx.events.filter((e) => e.kind === 'approval.decided' && subjectMatches(e.subject));
  // 审批绑修订：只有批在当前内容修订上的才算数；批完改过产出，旧的审批就是过期的。
  const revision = await stageRevision(ctx);
  const decisions = all.filter((e) => e.subject['revision'] === revision);
  const target = stage ? `--stage ${stage.id}` : '--archive';
  // 补救命令按策略给：允许 MCP 且清单配了审批者就点名它（MCP 批与人批同形）；否则给人批的形式。
  const allow = policy.allow ?? ['human', 'mcp'];
  const mcp = allow.includes('mcp') ? ctx.manifest.mcp_approvers?.[0]?.id : undefined;
  const command = mcp ? `xforge attest approve ${target} --via ${mcp}` : `xforge attest approve ${target} --decision approved`;
  const how = mcp && allow.includes('human') ? `；人批用 --decision approved` : '';
  if (all.length && !decisions.length) {
    return [{ token: 'approval-stale', ref: policyName, verb: 'attest', remedy: { command, text: `审批之后产出改过，审批作废；重批${how}` } }];
  }
  const last = decisions.at(-1);
  if (last?.decision === 'rejected') {
    return [{ token: 'approval-rejected', ref: policyName, verb: 'attest', remedy: { command, text: `最近一次审批是否决；处理后重新审批${how}` } }];
  }
  const approvers = new Set(decisions.filter((e) => e.decision === 'approved').map((e) => e.actor.email));
  if (approvers.size < policy.min_approvers) {
    return [{ token: 'approval-missing', ref: policyName, verb: 'attest', remedy: { command, text: `需要 ${policy.min_approvers} 人审批，已有 ${approvers.size}${how}` } }];
  }
  return [];
}

async function packagesCondition(ctx: ChangeCtx): Promise<Blocker[]> {
  if (!ctx.plan) return [{ token: 'plan-missing', ref: 'work-packages', verb: 'write', remedy: { text: '写 work-packages.yaml' } }];
  const out: Blocker[] = [];
  for (const p of ctx.plan.packages) {
    const state = ctx.packages.get(p.id) ?? 'ready';
    if (TERMINAL_PACKAGE_STATES.has(state)) continue;
    // 交付即集成：running 的包登记交付时就过集成前置；这里只剩派工与登记两种欠。
    const remedy: Blocker['remedy'] = state === 'running'
      ? { command: `xforge advance package ${p.id} --deliver`, text: '执行者写好交付记录后登记；验证门当前且通过就直接集成' }
      : state === 'ready'
        ? { command: `xforge advance package ${p.id} --dispatch`, text: '派工' }
        : { command: `xforge advance package ${p.id} --dispatch`, text: `执行者交付为 ${state}：看交付记录的 remaining；人裁决重新派工，或 xforge advance --rework-to design 调整计划` };
    out.push({ token: `package-pending:${p.id}`, ref: p.id, verb: 'advance', remedy });
  }
  return out;
}

async function unclaimedCondition(ctx: ChangeCtx): Promise<Blocker[]> {
  // 在本方案进站投影记下的工作目录里判：两个方案各在自己的 worktree，互不把对方的改动当无归属。
  const changed = await gitChangedPaths(workdirOf(ctx), ctx.declaration.baseline_commit);
  const claimed = picomatch((ctx.plan?.packages ?? []).flatMap((p) => p.paths));
  const unclaimed = changed.filter((p) => !p.startsWith('xforge/') && !claimed(p));
  return unclaimed.map((p) => ({ token: `unclaimed:${p}`, ref: p, verb: 'write' as const, remedy: { text: '把它归进某个包（改计划），或撤销它' } }));
}
