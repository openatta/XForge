// design: cli §2.4 — 证：谁，说了什么。一次一条；写审计事件；工作包机上捎带那一格的移动。
import type { Outcome } from '../cli/envelope.js';
import { CliError } from '../cli/errors.js';
import { ModelError } from '../model/errors.js';
import { appendEvent } from '../audit/chain.js';
import { gitAuthorsSince, gitIdentity, gitRemoteUrl } from '../audit/identity.js';
import { readText, Transaction } from '../fs/transaction.js';
import { gateStatus, loadGate, stageRevision } from '../gates/index.js';
import { actorString } from '../model/audit.js';
import { ledgerDigest, sha256 } from '../model/digest.js';
import { auditKindFor, requiresSignature } from '../model/ledger.js';
import type { AuditActor, Ledger, Manifest } from '../model/types.js';
import { parseYaml, toYaml } from '../model/yaml.js';
import { validate } from '../model/schemas.js';
import { callMcpTool } from '../mcp/client.js';
import { requireStage, workdirOf, type ChangeCtx, type Project } from './context.js';

export type AttestResult = { event: string; receipt?: string };

async function identity(ctx: Project): Promise<AuditActor> {
  const actor = await gitIdentity(ctx.root);
  if (!actor) throw new CliError('XF-ATTEST-001', '读不出 git 身份（user.name / user.email）', 1, { text: '配置 git 身份后再登记' });
  return actor;
}

async function readLedgerOrThrow(ctx: ChangeCtx, ref: string): Promise<{ ledger: Ledger; digest: string; path: string }> {
  const path = ctx.change.ledger(ref);
  const text = await readText(path);
  if (text === null) throw new CliError('XF-ADVANCE-001', `台账 ${ref} 不存在`, 1, { text: `先写 ledgers/${ref}.yaml` });
  try {
    return { ledger: parseYaml<Ledger>(text, 'ledger', ref), digest: ledgerDigest(text), path };
  } catch (error) {
    throw new CliError('XF-MODEL-001', `台账 ${ref} 形状不合法`, 1, { text: '按下面的字段改台账' }, error instanceof ModelError ? error.details : [(error as Error).message]);
  }
}

export async function attestApprove(ctx: ChangeCtx, opts: { stage?: string; archive: boolean; decision?: 'approved' | 'rejected'; note?: string; via?: string }): Promise<Outcome<AttestResult>> {
  const requester = await identity(ctx);
  let subject: Record<string, unknown>;
  let policyName: string | undefined;
  let stageId: string | null = null;
  if (opts.archive) {
    if (ctx.position.status !== 'ready-to-archive') throw new CliError('XF-ADVANCE-001', 'Change 不在 ready-to-archive，不能做终局审批', 1, { command: 'xforge state', text: '看位置' });
    subject = { archive: true, revision: await stageRevision(ctx) };
    policyName = ctx.flow.archive.exit.find((c) => c.kind === 'approval')?.['policy' as never] as string | undefined;
  } else {
    const stage = requireStage(ctx);
    if (opts.stage && opts.stage !== stage.id) throw new CliError('XF-ADVANCE-001', `当前站是 ${stage.id}，不是 ${opts.stage}`, 1, { command: 'xforge state', text: '看位置' });
    // 审批绑本站修订：批完再改产出，审批作废（approval-stale），要重批。
    subject = { stage: stage.id, revision: await stageRevision(ctx) };
    stageId = stage.id;
    const cond = stage.exit.find((c) => c.kind === 'approval');
    policyName = cond && cond.kind === 'approval' ? cond.policy : undefined;
  }
  const policy = policyName ? ctx.flow.approval_policies[policyName] : undefined;
  const allow = policy?.allow ?? ['human', 'mcp'];
  let actor: AuditActor = requester;
  let decision = opts.decision;
  const extra: { via?: string; requested_by?: string; evidence?: string; note?: string } = {};
  if (opts.note) extra.note = opts.note;
  if (opts.via) {
    // MCP 批 = 同意，与人批同形，只是方法不同：actor 是 MCP 回的 id，事件多记 via / requested_by / evidence。
    if (!allow.includes('mcp')) throw new CliError('XF-ATTEST-003', `审批策略 ${policyName ?? '?'} 不接受 MCP 审批`, 1, { text: '由人批，或改流程文件里该策略的 allow' });
    const cfg = ctx.manifest.mcp_approvers?.find((a) => a.id === opts.via);
    if (!cfg) throw new CliError('XF-ATTEST-002', `清单里没有 MCP 审批者 ${opts.via}`, 1, { text: '在 xforge/manifest.yaml 的 mcp_approvers 里配置它' });
    const request = await approvalRequest(ctx, subject, requester, stageId);
    let reply: unknown;
    try {
      reply = await callMcpTool({ server: cfg.server, tool: cfg.tool ?? 'approve', arguments: request, timeoutMs: (cfg.timeout_seconds ?? 120) * 1000, cwd: ctx.root });
    } catch (error) {
      throw new CliError('XF-ATTEST-004', `MCP 审批者 ${cfg.id} 没有给出有效答复：${(error as Error).message}`, 1, { text: '审批仍缺失；修好 MCP 服务后重跑，或由人批' });
    }
    const check = validate('mcp-approval', reply);
    if (!check.ok) throw new CliError('XF-ATTEST-004', `MCP 审批者 ${cfg.id} 的答复不合形状`, 1, { text: '答复必须是 {approver, decision: approved|rejected, note?}' }, check.errors);
    const verdict = reply as { approver: string; decision: 'approved' | 'rejected'; note?: string };
    actor = { name: verdict.approver, email: `${verdict.approver}@${cfg.id}.mcp` };
    decision = verdict.decision;
    extra.via = `mcp:${cfg.id}`;
    extra.requested_by = actorString(requester);
    extra.evidence = sha256(JSON.stringify(reply));
    if (verdict.note && !extra.note) extra.note = verdict.note;
  } else {
    if (!allow.includes('human')) throw new CliError('XF-ATTEST-003', `审批策略 ${policyName ?? '?'} 只接受 MCP 审批`, 1, { text: '用 --via <mcp-approver> 让配置的 MCP 来批' });
    if (!decision) throw new CliError('XF-ATTEST-003', '人批要带 --decision approved|rejected', 2, { text: '给出决定' });
    if (policy?.separation_of_duties) {
      const authors = await gitAuthorsSince(workdirOf(ctx), ctx.declaration.baseline_commit, ctx.scope?.paths ?? []);
      if (authors.includes(actorString(actor))) throw new CliError('XF-ATTEST-001', '审批人不能是实现者（separation_of_duties）', 1, { text: '换一个没有在作用域内提交过的人审批' });
    }
  }
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  const ev: Parameters<typeof appendEvent>[3] = { kind: 'approval.decided', change: ctx.changeId, scheme: ctx.scheme, subject, actor, decision: decision!, ...extra };
  const event = await appendEvent(tx, ctx.paths, ctx.chain, ev, ctx.env, ctx.now(), ctx.change.auditIndex, ctx.auditIndex);
  const changed = await tx.commit();
  return { result: { event: event.hash, ...(extra.via ? { via: extra.via, approver: actor.name, decision: decision! } : {}) }, changed, change: ctx.changeId, scheme: ctx.scheme, next: [{ command: 'xforge state', why: '看审批之后还欠什么' }] };
}

/** 给 MCP 的审批请求：来自哪个项目、哪个 Change、批什么、当时的修订、谁请求的、材料的引用与摘要。MCP 内部怎么审不是这里的事。 */
async function approvalRequest(ctx: ChangeCtx, subject: Record<string, unknown>, requester: AuditActor, stageId: string | null): Promise<Record<string, unknown>> {
  const stage = stageId ? ctx.flow.stages.find((s) => s.id === stageId) : undefined;
  const docs = (stage?.produces ?? []).filter((p) => !p.path.endsWith('/')).map((p) => `doc:${p.path}`);
  const ledgers: Array<{ kind: string; digest: string }> = [];
  for (const ref of stage?.ledgers ?? []) {
    if (ref === 'delivery') {
      for (const pkg of ctx.plan?.packages ?? []) {
        const text = await readText(ctx.change.ledger('delivery', pkg.id));
        if (text !== null) ledgers.push({ kind: `delivery/${pkg.id}`, digest: ledgerDigest(text) });
      }
      continue;
    }
    const text = await readText(ctx.change.ledger(ref));
    if (text !== null) ledgers.push({ kind: ref, digest: ledgerDigest(text) });
  }
  return {
    project: { git_url: await gitRemoteUrl(ctx.root), root: ctx.root },
    change: ctx.changeId,
    scheme: ctx.scheme,
    flow: ctx.flow.name,
    ...(stageId ? { stage: stageId } : { archive: true }),
    revision: subject['revision'],
    requested_by: actorString(requester),
    materials: { docs, ledgers },
  };
}

export async function attestEntry(ctx: ChangeCtx, ref: string, entryId: string): Promise<Outcome<AttestResult>> {
  const actor = await identity(ctx);
  const { ledger, digest } = await readLedgerOrThrow(ctx, ref);
  const entry = ledger.entries.find((e) => e.id === entryId);
  if (!entry) throw new CliError('XF-ADVANCE-001', `台账 ${ref} 里没有条目 ${entryId}`, 1, { text: '先在台账里写下这条' });
  if (!requiresSignature(ref, entry)) throw new CliError('XF-ADVANCE-001', `条目 ${entryId} 的结论 ${entry.conclusion} 不需要署名`, 1, { text: '只有需要人负责的结论才登记' });
  if (entry.signer !== actorString(actor)) throw new CliError('XF-ATTEST-001', `台账里的署名「${entry.signer ?? ''}」与当前身份「${actorString(actor)}」不一致`, 1, { text: '台账的 signer 必须与 git 身份逐字相等' });
  const kind = auditKindFor(ref);
  if (!kind) throw new CliError('XF-ADVANCE-001', `台账 ${ref} 不走「证」`, 1, { text: '交付记录由 attest delivery 确认' });
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  const event = await appendEvent(tx, ctx.paths, ctx.chain, { kind, change: ctx.changeId, scheme: ctx.scheme, subject: { ledger: ref, entry: entryId, digest }, actor }, ctx.env, ctx.now(), ctx.change.auditIndex, ctx.auditIndex);
  const changed = await tx.commit();
  return { result: { event: event.hash }, changed, change: ctx.changeId, scheme: ctx.scheme, next: [{ command: 'xforge state', why: '看还欠什么' }] };
}

export async function attestReceipt(ctx: ChangeCtx): Promise<Outcome<AttestResult>> {
  const actor = await identity(ctx);
  const ref = 'verification-receipt';
  const { ledger, digest } = await readLedgerOrThrow(ctx, ref);
  const me = actorString(actor);
  for (const e of ledger.entries) {
    if (e.signer !== me) throw new CliError('XF-ATTEST-001', `收据条目 ${e.id} 的署名「${e.signer ?? ''}」不是当前身份`, 1, { text: '每条都由签署者本人署名' });
    const gate = await loadGate(ctx, e.id);
    const s = await gateStatus(ctx, gate);
    if (s.status !== 'current') throw new CliError('XF-ADVANCE-003', `门 ${e.id} 不是当前且通过的（${s.status}）`, 1, { command: `xforge run --gate ${e.id}`, text: '先让每道门当前且通过，再签' });
  }
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  const event = await appendEvent(tx, ctx.paths, ctx.chain, { kind: 'receipt.signed', change: ctx.changeId, scheme: ctx.scheme, subject: { ledger: ref, digest }, actor }, ctx.env, ctx.now(), ctx.change.auditIndex, ctx.auditIndex);
  const changed = await tx.commit();
  return { result: { event: event.hash }, changed, change: ctx.changeId, scheme: ctx.scheme, next: [{ command: 'xforge advance', why: '收据已签，出站' }] };
}


export async function attestVerification(project: Project, commands: Record<string, string>): Promise<Outcome<AttestResult>> {
  const actor = await identity(project);
  const manifestText = (await readText(project.paths.manifest)) ?? '';
  const manifest: Manifest = { ...project.manifest, verification: { commands: { ...(project.manifest.verification?.commands ?? {}), ...commands } } };
  const nextText = toYaml(manifest);
  const tx = new Transaction(project.root, project.paths.txDir);
  tx.write(project.paths.manifest, nextText);
  const { readChain } = await import('../audit/chain.js');
  const chain = await readChain(project.paths);
  const event = await appendEvent(tx, project.paths, chain, { kind: 'verification.declared', subject: { commands: Object.keys(commands), manifest_digest: sha256(nextText), previous_digest: sha256(manifestText) }, actor }, project.env, project.now());
  const changed = await tx.commit();
  return { result: { event: event.hash }, changed, next: [{ command: 'xforge state', why: '门现在有命令可跑了' }] };
}
