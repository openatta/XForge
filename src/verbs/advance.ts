// design: cli §2.5 — 进：状态机走一格。Stage 机默认先产；工作包机上派工与交付；归档合并基线。
import picomatch from 'picomatch';
import type { Outcome } from '../cli/envelope.js';
import { CliError } from '../cli/errors.js';
import { ModelError } from '../model/errors.js';
import { gitChangedPaths } from '../audit/identity.js';
import { mergeDeltas } from '../baselines/index.js';
import { readText, Transaction } from '../fs/transaction.js';
import { gateStatus, latestRun, loadGate, stageRevision } from '../gates/index.js';
import { lastDispatch, writeReceipt, type PackageState } from '../machines/receipts.js';
import { packageMoveAllowed, TERMINAL_PACKAGE_STATES } from '../machines/transitions.js';
import { ledgerDigest } from '../model/digest.js';
import { READY_TO_ARCHIVE, ARCHIVED, stageIndex } from '../model/flow.js';
import { newExecutionId } from '../model/ids.js';
import type { EnvelopeDiagnostic, Ledger, Projection, ReceiptInputs, Stage } from '../model/types.js';
import { parseYaml, toYaml } from '../model/yaml.js';
import { coversCwd, globCoveredBy } from '../model/projection.js';
import { closeProjections, openProjection, readProjections } from '../projection/index.js';
import { listSchemes, requireStage, type ChangeCtx } from './context.js';
import { DEFAULT_SCHEME } from '../model/paths.js';
import { evaluateArchiveExit, evaluateExit, type Blocker } from './exit.js';
import { runInspect } from './inspect.js';
import { diagnosticsFor, runGates } from './run.js';
import { stageSlice, type StageSlice } from './slice.js';

export interface AdvanceResult {
  receipt?: string;
  to?: string;
  stage?: StageSlice;
  blockers?: Blocker[];
  draft?: string;
  execution?: string;
  /** 派工时把计划里这个包的条目一并回：包执行者的简报不必再去读计划。 */
  package?: { id: string; title: string; paths: string[]; verify: { gate: string }; criteria: Array<{ id: string; text: string }>; review: string };
}

function blocked(ctx: ChangeCtx, blockers: Blocker[], what: string): Outcome<AdvanceResult> {
  const diagnostics: EnvelopeDiagnostic[] = [{ code: 'XF-ADVANCE-001', severity: 'blocking', message: `${what}：${blockers.map((b) => b.token).join('、')}`, remedy: { command: 'xforge state', text: '看 blockers，每一项都对应一个动词' } }];
  return { result: { blockers }, diagnostics, change: ctx.changeId, scheme: ctx.scheme, next: blockers.filter((b) => b.remedy.command).slice(0, 3).map((b) => ({ command: b.remedy.command!, why: b.token })) };
}

async function stageInputs(ctx: ChangeCtx, stage: Stage): Promise<ReceiptInputs> {
  const inputs: ReceiptInputs = { gates: [], ledgers: [], audit_events: [] };
  for (const name of stage.gates) {
    const run = await latestRun(ctx, name);
    if (run) inputs.gates!.push({ gate: name, run: run.run, revision: run.revision });
  }
  for (const ref of stage.ledgers) {
    if (ref === 'delivery') continue;
    const text = await readText(ctx.change.ledger(ref));
    if (text !== null) inputs.ledgers!.push({ kind: ref, digest: ledgerDigest(text) });
  }
  inputs.audit_events = ctx.events.filter((e) => e.kind === 'approval.decided' && e.subject['stage'] === stage.id).map((e) => e.hash);
  return inputs;
}

/** 两个方案不能共用一个工作目录：执法按工作目录取在途投影，共用会让两边的范围互相污染（XF-ADVANCE-010）。 */
async function refuseSharedWorkdir(ctx: ChangeCtx, workdir: string): Promise<void> {
  const schemes = [DEFAULT_SCHEME, ...(await listSchemes(ctx.change))].filter((s) => s !== ctx.scheme);
  for (const s of schemes) {
    const theirs = await readProjections(ctx.paths.change(ctx.changeId, s));
    const clash = theirs.find((p) => p.closed_by === null && (coversCwd(p.workdir, workdir) || coversCwd(workdir, p.workdir)));
    if (clash) throw new CliError('XF-ADVANCE-010', `工作目录 ${workdir} 已被方案 ${s} 的在途投影 ${clash.execution} 占用（${clash.workdir}）`, 1, { text: '给这个方案单独开一个 worktree，用 --workdir 指过去' });
  }
}

export async function advanceStage(ctx: ChangeCtx, opts: { noRun: boolean; workdir: string }): Promise<Outcome<AdvanceResult>> {
  const stage = requireStage(ctx);
  if (ctx.scope) await refuseSharedWorkdir(ctx, opts.workdir);
  const diagnostics: EnvelopeDiagnostic[] = [];
  let changed: string[] = [];
  if (!opts.noRun) {
    const tx = new Transaction(ctx.root, ctx.paths.txDir);
    const outcomes = await runGates(ctx, stage, tx, {});
    changed = await tx.commit();
    diagnostics.push(...diagnosticsFor(outcomes));
    if (diagnostics.length) return { result: {}, diagnostics, changed, change: ctx.changeId, scheme: ctx.scheme, next: [{ command: 'xforge state', why: '门没过' }] };
  }
  const blockers = await evaluateExit(ctx, stage);
  if (blockers.length) {
    const stale = blockers.find((b) => b.token === 'gate-stale');
    if (stale && opts.noRun) throw new CliError('XF-ADVANCE-003', `门 ${stale.ref} 的记录已过期`, 1, { command: `xforge run --gate ${stale.ref}`, text: '重跑这道门' });
    const b = blocked(ctx, blockers, '出口条件不满足');
    b.changed = changed;
    return b;
  }
  const index = stageIndex(ctx.flow, stage.id);
  const next = ctx.flow.stages[index + 1] ?? null;
  const to = next ? next.id : READY_TO_ARCHIVE;
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  const receipt = writeReceipt(tx, ctx.change, ctx.receipts, { change: ctx.changeId, scheme: ctx.scheme }, ctx.now(), {
    kind: 'stage-transition',
    from: stage.id,
    to,
    subject: { stage: stage.id },
    inputs: await stageInputs(ctx, stage),
    revision: await stageRevision(ctx),
    workdir: opts.workdir,
  });
  closeProjections(tx, ctx.change, ctx.projections, (p) => p.kind === 'stage', receipt.id);
  let execution: string | undefined;
  if (next && ctx.scope) {
    execution = newExecutionId(new Date(ctx.now()));
    const p: Projection = { execution, kind: 'stage', change: ctx.changeId, scheme: ctx.scheme, stage: next.id, workdir: opts.workdir, opened_by: receipt.id, closed_by: null, allow: ctx.scope.paths };
    openProjection(tx, ctx.change, p);
  }
  changed = [...changed, ...(await tx.commit())];
  const result: AdvanceResult = { receipt: receipt.id, to };
  if (execution) result.execution = execution;
  // 结果是下一站的切片；切片要看到新位置，所以在新的上下文上算（receipts 已含这一环）。
  if (next) {
    const fresh: ChangeCtx = { ...ctx, receipts: [...ctx.receipts, receipt], position: { stage: next.id, status: 'in-stage' } };
    result.stage = await stageSlice(fresh, next);
  }
  return { result, changed, change: ctx.changeId, scheme: ctx.scheme, next: next ? [{ command: 'xforge state', why: `已进入 ${next.id}` }] : [{ command: 'xforge attest approve --archive --decision approved', why: '到 ready-to-archive 了，需要终局审批' }] };
}

export async function advanceRework(ctx: ChangeCtx, target: string, reason: string, workdir: string): Promise<Outcome<AdvanceResult>> {
  const stage = requireStage(ctx);
  if (ctx.scope) await refuseSharedWorkdir(ctx, workdir);
  if (!stage.rework_to.includes(target)) throw new CliError('XF-ADVANCE-002', `${stage.id} 不能退到 ${target}（允许：${stage.rework_to.join('、') || '无'}）`, 1, { text: '只能退到流程声明允许的站' });
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  const receipt = writeReceipt(tx, ctx.change, ctx.receipts, { change: ctx.changeId, scheme: ctx.scheme }, ctx.now(), { kind: 'rework', from: stage.id, to: target, subject: { stage: stage.id, reason }, workdir });
  closeProjections(tx, ctx.change, ctx.projections, (p) => p.kind === 'stage', receipt.id);
  if (ctx.scope) {
    openProjection(tx, ctx.change, { execution: newExecutionId(new Date(ctx.now())), kind: 'stage', change: ctx.changeId, scheme: ctx.scheme, stage: target, workdir, opened_by: receipt.id, closed_by: null, allow: ctx.scope.paths });
  }
  const changed = await tx.commit();
  const targetStage = ctx.flow.stages.find((s) => s.id === target)!;
  const fresh: ChangeCtx = { ...ctx, receipts: [...ctx.receipts, receipt], position: { stage: target, status: 'in-stage' } };
  return { result: { receipt: receipt.id, to: target, stage: await stageSlice(fresh, targetStage) }, changed, change: ctx.changeId, scheme: ctx.scheme, next: [{ command: 'xforge state', why: `已退回 ${target}；台账里用 supersedes 承接 ${receipt.id}` }] };
}

export async function advanceDispatch(ctx: ChangeCtx, packageId: string, workdir: string): Promise<Outcome<AdvanceResult>> {
  const stage = requireStage(ctx);
  if (!stage.ledgers.includes('delivery')) throw new CliError('XF-ADVANCE-001', `${stage.id} 站不派工`, 1, { command: 'xforge state', text: '看位置' });
  const pkg = ctx.plan?.packages.find((p) => p.id === packageId);
  if (!pkg) throw new CliError('XF-ADVANCE-001', `计划里没有包 ${packageId}`, 1, { text: '先写 work-packages.yaml' });
  const state: PackageState = ctx.packages.get(packageId) ?? 'ready';
  if (!packageMoveAllowed(state, 'running', 'dispatch')) throw new CliError('XF-ADVANCE-001', `包 ${packageId} 在 ${state}，不能派工`, 1, { command: 'xforge state', text: '看包的状态' });
  for (const dep of pkg.depends_on) {
    const ds = ctx.packages.get(dep) ?? 'ready';
    if (!TERMINAL_PACKAGE_STATES.has(ds)) throw new CliError('XF-ADVANCE-004', `依赖的包 ${dep} 在 ${ds}`, 1, { command: 'xforge state', text: '先把依赖的包集成' });
  }
  if (!ctx.scope) throw new CliError('XF-ADVANCE-006', '没有作用域声明', 1, { text: '先写 scope.yaml' });
  for (const p of pkg.paths) if (!globCoveredBy(ctx.scope.paths, p)) throw new CliError('XF-ADVANCE-006', `包路径 ${p} 不在作用域内`, 1, { text: '改 work-packages.yaml 或 scope.yaml' });
  await refuseSharedWorkdir(ctx, workdir);
  const execution = newExecutionId(new Date(ctx.now()));
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  const receipt = writeReceipt(tx, ctx.change, ctx.receipts, { change: ctx.changeId, scheme: ctx.scheme }, ctx.now(), { kind: 'package-dispatch', from: state, to: 'running', subject: { package: packageId }, execution, workdir });
  openProjection(tx, ctx.change, { execution, kind: 'package', change: ctx.changeId, scheme: ctx.scheme, stage: stage.id, package: packageId, workdir, opened_by: receipt.id, closed_by: null, allow: pkg.paths });
  const changed = await tx.commit();
  const draft = [
    'kind: delivery',
    'entries:',
    `  - id: ${execution}`,
    `    package: ${packageId}`,
    `    baseline_commit: ${ctx.declaration.baseline_commit}`,
    '    paths_changed: []          # 执行者填：相对项目根的路径；advance --deliver 按 git diff 核对',
    '    conclusion: succeeded      # succeeded | failed | blocked',
    `    refs: [evidence/gates/${pkg.verify.gate}/<run>.yaml]`,
    '    criteria:',
    ...pkg.criteria.map((c) => `      - {id: ${c.id}, evidence: "<可定位的证据>"}   # ${c.text}`),
    '    remaining: []',
    `    signer: ${execution}`,
    '    at: <ISO 时间>',
    '',
  ].join('\n');
  return { result: { receipt: receipt.id, to: 'running', execution, draft, package: { id: pkg.id, title: pkg.title, paths: pkg.paths, verify: pkg.verify, criteria: pkg.criteria, review: pkg.review } }, changed, change: ctx.changeId, scheme: ctx.scheme, next: [{ command: `xforge run --package ${packageId}`, why: '写完代码后跑这个包的验证门' }, { command: `xforge advance package ${packageId} --deliver`, why: '写好交付记录后登记' }] };
}

export async function advanceDeliver(ctx: ChangeCtx, packageId: string): Promise<Outcome<AdvanceResult>> {
  requireStage(ctx);
  const pkg = ctx.plan?.packages.find((p) => p.id === packageId);
  if (!pkg) throw new CliError('XF-ADVANCE-001', `计划里没有包 ${packageId}`, 1, { text: '先写 work-packages.yaml' });
  const state: PackageState = ctx.packages.get(packageId) ?? 'ready';
  if (state !== 'running') throw new CliError('XF-ADVANCE-001', `包 ${packageId} 在 ${state}，不是 running`, 1, { command: 'xforge state', text: '看包的状态' });
  const dispatch = lastDispatch(ctx.receipts, packageId)!;
  const path = ctx.change.ledger('delivery', packageId);
  const text = await readText(path);
  if (text === null) throw new CliError('XF-ADVANCE-001', `交付记录 ${packageId} 不存在`, 1, { text: '执行者先写 ledgers/deliveries/' + packageId + '.yaml' });
  let ledger: Ledger;
  try {
    ledger = parseYaml<Ledger>(text, 'ledger', path);
  } catch (error) {
    throw new CliError('XF-MODEL-001', `交付记录 ${packageId} 形状不合法`, 1, { text: '按下面的字段改交付记录' }, error instanceof ModelError ? error.details : [(error as Error).message]);
  }
  const entry = ledger.entries.find((e) => e.id === dispatch.execution);
  if (!entry || entry.signer !== dispatch.execution) throw new CliError('XF-ADVANCE-005', `交付记录的署名不是这次派工的执行 id ${dispatch.execution}`, 1, { text: '交付记录由被派工的执行者填，signer 必须是它的执行 id' });
  const workdir = dispatch.workdir ?? ctx.root;
  const actual = (await gitChangedPaths(workdir, ctx.declaration.baseline_commit)).filter((p) => !p.startsWith('xforge/'));
  const inPkg = picomatch(pkg.paths);
  const actualInPkg = actual.filter((p) => inPkg(p)).sort();
  const declared = [...(entry.paths_changed ?? [])].sort();
  if (JSON.stringify(actualInPkg) !== JSON.stringify(declared)) {
    throw new CliError('XF-ADVANCE-009', `交付记录的 paths_changed 与工作树不符：声明 [${declared.join('、')}]，实际 [${actualInPkg.join('、')}]`, 1, { text: '以工作树为准改交付记录' });
  }
  // 交付即集成：succeeded 的交付要过集成的机械前置（验证门当前且通过），过了直接落 integrated，没有人确认这一格。
  let to: PackageState = entry.conclusion as PackageState;
  if (entry.conclusion === 'succeeded') {
    const gate = await loadGate(ctx, pkg.verify.gate);
    const s = await gateStatus(ctx, gate, pkg.paths);
    if (s.status !== 'current') throw new CliError('XF-ADVANCE-003', `包 ${packageId} 的验证门 ${gate.name} 不是当前且通过的（${s.status}）`, 1, { command: `xforge run --package ${packageId}`, text: '先跑验证门再登记交付' });
    to = 'integrated';
  }
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  const receipt = writeReceipt(tx, ctx.change, ctx.receipts, { change: ctx.changeId, scheme: ctx.scheme }, ctx.now(), {
    kind: 'package-deliver',
    from: 'running',
    to,
    subject: { package: packageId },
    execution: dispatch.execution!,
    inputs: { ledgers: [{ kind: 'delivery', digest: ledgerDigest(text) }], paths: actualInPkg },
  });
  if (to === 'integrated') closeProjections(tx, ctx.change, ctx.projections, (p) => p.kind === 'package' && p.package === packageId, receipt.id);
  const changed = await tx.commit();
  // 交付登记之后本站还欠什么，一并回：读者不必再 state。
  const fresh: ChangeCtx = { ...ctx, receipts: [...ctx.receipts, receipt], packages: new Map([...ctx.packages, [packageId, to]]) };
  const blockers = await evaluateExit(fresh, requireStage(fresh));
  const next = to === 'integrated' ? [{ command: 'xforge state', why: '包已集成，看本站还欠什么' }] : [{ command: `xforge advance package ${packageId} --dispatch`, why: '重新派工' }];
  return { result: { receipt: receipt.id, to, blockers }, changed, change: ctx.changeId, scheme: ctx.scheme, next };
}

export async function advanceArchive(ctx: ChangeCtx): Promise<Outcome<AdvanceResult>> {
  if (ctx.position.status !== 'ready-to-archive') throw new CliError('XF-ADVANCE-001', `Change 在 ${ctx.position.stage ?? ctx.position.status}，不是 ready-to-archive`, 1, { command: 'xforge state', text: '看位置' });
  const hygiene = await runInspect(ctx, { hygiene: true });
  const red = hygiene.diagnostics?.filter((d) => d.severity === 'blocking') ?? [];
  if (red.length) throw new CliError('XF-ADVANCE-008', `归档前卫生检查未通过：${red.map((d) => d.code).join('、')}`, 1, { command: 'xforge inspect --hygiene', text: '按它的诊断清理' });
  const blockers = await evaluateArchiveExit(ctx);
  if (blockers.length) return blocked(ctx, blockers, '终局条件不满足');
  const tx = new Transaction(ctx.root, ctx.paths.txDir);
  const merged: string[] = [];
  if (ctx.open.has('spec')) merged.push(...(await mergeDeltas(tx, ctx.paths, 'spec', ctx.change.specDeltaDir)).files);
  if (ctx.open.has('interface')) merged.push(...(await mergeDeltas(tx, ctx.paths, 'interface', ctx.change.interfaceDeltaDir)).files);
  const receipt = writeReceipt(tx, ctx.change, ctx.receipts, { change: ctx.changeId, scheme: ctx.scheme }, ctx.now(), {
    kind: 'archive',
    from: READY_TO_ARCHIVE,
    to: ARCHIVED,
    subject: { archive: true, merged: merged.length },
    inputs: { audit_events: ctx.events.filter((e) => e.kind === 'approval.decided' && e.subject['archive'] === true).map((e) => e.hash) },
    revision: await stageRevision(ctx),
  });
  // 归档是 Change 级：标记写在 Change 根，别的方案由此看到 archived。
  tx.write(ctx.change.archiveMarker, toYaml({ scheme: ctx.scheme, receipt: receipt.id, at: ctx.now() }));
  const changed = await tx.commit();
  return { result: { receipt: receipt.id, to: ARCHIVED }, changed, change: ctx.changeId, scheme: ctx.scheme, next: [] };
}
