// design: rule-files §3.2 — 门：读定义、算输入修订、跑命令或内置逻辑、受理台账、写运行记录。
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import fg from 'fast-glob';
import { CliError } from '../cli/errors.js';
import { exists, readText, type Transaction } from '../fs/transaction.js';
import { lastDispatch } from '../machines/receipts.js';
import { contentRevision, ledgerDigest } from '../model/digest.js';
import { ModelError } from '../model/errors.js';
import { isOwed } from '../model/flow.js';
import { validateLedger } from '../model/ledger.js';
import { constitutionTitles, deltaOps, entriesBlocks, headings } from '../model/markdown.js';
import { DEFAULT_SCHEME } from '../model/paths.js';
import type { BaselineEntries, Gate, GateRun, Ledger, Stage } from '../model/types.js';
import { parseYaml, readYaml, toYaml } from '../model/yaml.js';
import { artifactPath, currentStage, listSchemes, workdirOf, type ChangeCtx } from '../verbs/context.js';

export async function loadGate(ctx: ChangeCtx, name: string): Promise<Gate> {
  if (!ctx.manifest.selected.gates.includes(name)) {
    throw new CliError('XF-MODEL-002', `门 ${name} 不在清单 selected.gates 里`, 3, { text: '把它加进清单，或从流程里去掉' });
  }
  try {
    return await readYaml<Gate>(ctx.paths.gate(name), 'gate');
  } catch (error) {
    if (error instanceof ModelError) throw new CliError('XF-MODEL-002', `门 ${name} 的定义读不出来`, 3, { text: '补上或修好 xforge/scaffold/gates/' + name + '.yaml' }, error.details);
    throw error;
  }
}

export function gateOwed(ctx: ChangeCtx, gate: Gate): boolean {
  return isOwed({ needs: gate.needs ?? [] }, ctx.open, ctx.scheme === DEFAULT_SCHEME);
}

export function effectiveInputs(ctx: ChangeCtx, gate: Gate, override?: readonly string[]): string[] {
  // `${change}` 是 Change 根（规格侧共享），`${impl}` 是本方案的实现侧目录（默认方案两者相同）。
  return (override ?? gate.inputs).map((g) => g.replaceAll('xforge/changes/${change}', ctx.change.changeRel).replaceAll('${impl}', ctx.change.implRel).replaceAll('${change}', ctx.changeId));
}

/** 默认方案的实现侧就是 Change 根：算修订时把具名方案的子目录排除，否则兄弟方案一动它的门就过期。 */
async function siblingSchemeIgnores(ctx: ChangeCtx): Promise<string[]> {
  if (ctx.scheme !== DEFAULT_SCHEME) return [];
  return (await listSchemes(ctx.change)).map((s) => `${ctx.change.changeRel}/${s}/**`);
}

/** 输入修订：inputs 里的 `${change}` 换成 Change id；`--package` 时用包路径替代。 */
export async function gateRevision(ctx: ChangeCtx, gate: Gate, override?: readonly string[]): Promise<string> {
  const globs = effectiveInputs(ctx, gate, override);
  // 治理侧的输入（xforge/**）在治理根；项目侧的输入在本方案的工作目录（worktree 里跑的方案看自己的树）。
  const isGov = (g: string): boolean => g.replace(/^!/, '').startsWith('xforge/');
  const ignore = ['**/node_modules/**', '**/.git/**', ...(await siblingSchemeIgnores(ctx))];
  const workdir = workdirOf(ctx);
  const entries: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const [cwd, subset, gov] of [[ctx.root, globs.filter(isGov), true], [workdir, globs.filter((g) => !isGov(g)), false]] as const) {
    if (!subset.some((g) => !g.startsWith('!'))) continue;
    // 项目侧在工作目录里算，且不看它检出的 xforge/ 副本；治理侧在治理根算。
    const files = await fg([...subset, ...(gov ? [] : ['!xforge/**'])], { cwd, dot: true, onlyFiles: true, ignore });
    for (const f of files.sort()) entries.push({ path: f, bytes: await readFile(join(cwd, f)) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return contentRevision(entries);
}

/**
 * 最近一次运行；给了 inputs 就只认输入集相同的那一次 —— 站级运行（整树）与包级运行（包路径）
 * 是两个不同的修订空间，互相不能作对方的「当前」。
 */
/** 本站的内容修订：实现侧目录去掉证据；出站 receipt 与审批事件都绑它。 */
export async function stageRevision(ctx: ChangeCtx): Promise<string> {
  const gate: Gate = { name: 'stage', kind: 'builtin', inputs: ['${impl}/**', '!${impl}/evidence/**'] } as Gate;
  return gateRevision(ctx, gate);
}

/** 判定依赖站的内置门：同一份输入在 propose 站通过，不等于在 design 站也通过（欠的产出不同）。它们的「当前」还要站相同。 */
export function stageScoped(gate: Gate): boolean {
  return gate.kind === 'builtin' && (gate.builtin === 'structure' || gate.builtin === 'ledgers' || gate.builtin === 'constitution');
}

export async function latestRun(ctx: ChangeCtx, gate: string, inputs?: readonly string[], stage?: string): Promise<GateRun | null> {
  let files: string[];
  try {
    files = (await readdir(ctx.change.gateRunsDir(gate))).filter((f) => f.endsWith('.yaml'));
  } catch {
    return null;
  }
  const runs = files.map((f) => Number(f.slice(0, -5))).filter((n) => Number.isInteger(n)).sort((a, b) => b - a);
  const want = inputs ? JSON.stringify([...inputs]) : null;
  for (const n of runs) {
    const run = await readYaml<GateRun>(ctx.change.gateRun(gate, n), 'gate-run');
    if (!want) return run;
    if (JSON.stringify(run.inputs ?? []) !== want) continue;
    if (stage !== undefined && run.stage !== stage) continue;
    return run;
  }
  return null;
}

/** 下一个运行号：该门下全部运行里最大的加一（不按输入集分）。 */
async function nextRunNumber(ctx: ChangeCtx, gate: string): Promise<number> {
  try {
    const files = (await readdir(ctx.change.gateRunsDir(gate))).filter((f) => f.endsWith('.yaml'));
    const runs = files.map((f) => Number(f.slice(0, -5))).filter((n) => Number.isInteger(n));
    return (runs.length ? Math.max(...runs) : 0) + 1;
  } catch {
    return 1;
  }
}

export type GateStatus = 'current' | 'stale' | 'failed' | 'missing' | 'not-owed';

export async function gateStatus(ctx: ChangeCtx, gate: Gate, override?: readonly string[]): Promise<{ status: GateStatus; run: GateRun | null; revision: string }> {
  if (!gateOwed(ctx, gate)) return { status: 'not-owed', run: null, revision: '' };
  const revision = await gateRevision(ctx, gate, override);
  const run = await latestRun(ctx, gate.name, effectiveInputs(ctx, gate, override), stageScoped(gate) ? (currentStage(ctx)?.id ?? '') : undefined);
  if (!run) return { status: 'missing', run: null, revision };
  if (run.revision !== revision) return { status: 'stale', run, revision };
  return { status: run.result === 'passed' ? 'current' : 'failed', run, revision };
}

export interface RunOptions {
  stage: Stage;
  packageId?: string;
  packagePaths?: readonly string[];
  force?: boolean;
}

export interface RunOutcome {
  gate: string;
  run: number;
  result: 'passed' | 'failed' | 'current' | 'not-owed';
  exit_code?: number;
  log?: string;
  tail?: string;
  accepted?: GateRun['accepted'];
  reasons?: string[];
}

/** 跑一道门：写运行记录（与 log 同一事务），回摘要。 */
export async function runGate(ctx: ChangeCtx, gate: Gate, tx: Transaction, opts: RunOptions): Promise<RunOutcome> {
  if (!gateOwed(ctx, gate)) return { gate: gate.name, run: 0, result: 'not-owed' };
  const status = await gateStatus(ctx, gate, opts.packagePaths);
  if (status.status === 'current' && !opts.force) return { gate: gate.name, run: status.run!.run, result: 'current' };
  const runNo = await nextRunNumber(ctx, gate.name);
  const record: GateRun = { gate: gate.name, run: runNo, at: ctx.now(), revision: status.revision, result: 'passed', inputs: effectiveInputs(ctx, gate, opts.packagePaths), ...(stageScoped(gate) ? { stage: opts.stage.id } : {}) };
  const outcome: RunOutcome = { gate: gate.name, run: runNo, result: 'passed' };

  if (gate.kind === 'command') {
    const command = ctx.manifest.verification?.commands[gate.name];
    if (!command) {
      throw new CliError('XF-RUN-001', `门 ${gate.name} 的命令未声明`, 1, { command: `xforge attest verification --command ${gate.name}="<command>"`, text: '由人声明这个项目用什么命令验证自己' });
    }
    const { code, output, timedOut } = await runCommand(command, workdirOf(ctx), (gate.timeout_seconds ?? 600) * 1000);
    record.exit_code = code;
    record.log = `${runNo}.log`;
    record.result = code === 0 && !timedOut ? 'passed' : 'failed';
    tx.write(ctx.change.gateLog(gate.name, runNo), output);
    outcome.result = record.result;
    outcome.exit_code = code;
    outcome.log = relative(ctx.root, ctx.change.gateLog(gate.name, runNo));
    if (record.result === 'failed') outcome.tail = output.split('\n').slice(-40).join('\n');
    if (timedOut) {
      tx.write(ctx.change.gateRun(gate.name, runNo), toYaml(record));
      throw new CliError('XF-RUN-002', `门 ${gate.name} 超时`, 1, { text: '看 log；必要时在门定义里调大 timeout_seconds' });
    }
  } else {
    const verdict = await runBuiltin(ctx, gate, opts);
    record.result = verdict.passed ? 'passed' : 'failed';
    if (verdict.accepted.length) record.accepted = verdict.accepted;
    outcome.result = record.result;
    if (verdict.reasons.length) outcome.reasons = verdict.reasons;
    if (verdict.accepted.length) outcome.accepted = verdict.accepted;
  }
  tx.write(ctx.change.gateRun(gate.name, runNo), toYaml(record));
  return outcome;
}

async function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env: process.env });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, timedOut });
    });
  });
}

interface Verdict {
  passed: boolean;
  reasons: string[];
  accepted: NonNullable<GateRun['accepted']>;
}

async function runBuiltin(ctx: ChangeCtx, gate: Gate, opts: RunOptions): Promise<Verdict> {
  switch (gate.builtin) {
    case 'structure':
      return structureGate(ctx, opts.stage);
    case 'ledgers':
      return ledgersGate(ctx, opts.stage, gate.accepts ?? []);
    case 'constitution':
      return constitutionGate(ctx, opts.stage);
    case 'spec-delta':
      return deltaGate(ctx, 'spec');
    case 'interface-delta':
      return deltaGate(ctx, 'interface');
    case 'interface-compat':
      return compatGate(ctx);
    default:
      return { passed: false, reasons: [`未知内置门 ${String(gate.builtin)}`], accepted: [] };
  }
}

/** structure：本站每份欠着的产出存在；skeleton/mixed 的二级标题集合精确等于 outline；标记数 ≥ min。 */
async function structureGate(ctx: ChangeCtx, stage: Stage): Promise<Verdict> {
  const reasons: string[] = [];
  // 作用域声明里的 scheme 必须是被寻址的方案：写错方案目录的作用域不是这个方案的。
  if (ctx.scope && ctx.scope.scheme !== ctx.scheme) reasons.push(`scope.yaml 的 scheme 是 ${ctx.scope.scheme}，本方案是 ${ctx.scheme}`);
  for (const p of stage.produces) {
    if (!isOwed(p, ctx.open, ctx.scheme === DEFAULT_SCHEME)) continue;
    const path = artifactPath(ctx.change, p.path);
    if (p.path.endsWith('/')) {
      if (!(await exists(path))) reasons.push(`${p.path} 不存在`);
      continue;
    }
    const text = await readText(path);
    if (text === null) {
      reasons.push(`${p.path} 不存在`);
      continue;
    }
    if (p.read === 'entries') {
      if (p.path.endsWith('.yaml')) {
        try {
          parseYaml(text, schemaFor(p.path), p.path);
        } catch (error) {
          reasons.push(`${p.path}: ${(error as Error).message}`);
        }
      }
      continue;
    }
    const got = headings(text, 2);
    const want = p.outline ?? [];
    if (got.join('\n') !== want.join('\n')) reasons.push(`${p.path} 的二级标题应为 [${want.join('、')}]，实际 [${got.join('、')}]`);
    if (p.read === 'mixed') {
      const blocks = entriesBlocks(text);
      for (const m of p.markers ?? []) {
        const n = blocks.filter((b) => b.kind === m.kind).length;
        if (n < m.min) reasons.push(`${p.path} 的条目区 ${m.kind} 需要 ≥${m.min} 处，实际 ${n}`);
      }
    }
  }
  return { passed: reasons.length === 0, reasons, accepted: [] };
}

function schemaFor(path: string): 'change' | 'scope' | 'work-packages' {
  if (path.endsWith('change.yaml')) return 'change';
  if (path.endsWith('scope.yaml')) return 'scope';
  return 'work-packages';
}

/** ledgers：本站声明的台账存在、形状合法；受理它们。 */
async function ledgersGate(ctx: ChangeCtx, stage: Stage, accepts: readonly string[]): Promise<Verdict> {
  const reasons: string[] = [];
  const accepted: NonNullable<GateRun['accepted']> = [];
  const targets: Array<{ ref: string; path: string; pkg?: string }> = [];
  for (const ref of stage.ledgers) {
    if (!accepts.includes(ref) && !(ref.startsWith('exit/') && accepts.includes('exit'))) continue;
    if (ref === 'delivery') {
      for (const pkg of ctx.plan?.packages ?? []) targets.push({ ref, path: join(ctx.change.ledgersDir, 'deliveries', `${pkg.id}.yaml`), pkg: pkg.id });
      continue;
    }
    targets.push({ ref, path: ctx.change.ledger(ref) });
  }
  for (const t of targets) {
    const text = await readText(t.path);
    if (text === null) {
      reasons.push(`台账 ${t.ref}${t.pkg ? `(${t.pkg})` : ''} 不存在`);
      continue;
    }
    const digest = ledgerDigest(text);
    let ledger: Ledger;
    try {
      ledger = parseYaml<Ledger>(text, 'ledger', t.path);
    } catch (error) {
      const why = (error as ModelError).details?.join('；') || (error as Error).message;
      accepted.push({ ledger: t.ref, digest, verdict: 'rejected', reasons: [why] });
      reasons.push(`台账 ${t.ref} 形状不合法：${why}`);
      continue;
    }
    const problems = validateLedger(ledger);
    if (ledger.kind !== t.ref) problems.push(`kind 应为 ${t.ref}，实际 ${ledger.kind}`);
    if (t.pkg) {
      const dispatch = lastDispatch(ctx.receipts, t.pkg);
      for (const e of ledger.entries) {
        if (e.package !== t.pkg) problems.push(`条目 ${e.id} 的 package 应为 ${t.pkg}`);
        if (dispatch && e.id !== dispatch.execution) problems.push(`条目 ${e.id} 不是最近一次派工的执行 id ${dispatch.execution}`);
      }
    }
    if (problems.length) {
      accepted.push({ ledger: t.ref, digest, verdict: 'rejected', reasons: problems });
      reasons.push(`台账 ${t.ref} 未被受理：${problems.join('；')}`);
    } else {
      accepted.push({ ledger: t.ref, digest, verdict: 'accepted' });
    }
  }
  return { passed: reasons.length === 0, reasons, accepted };
}

/** constitution：章程可读；若本站有章程答复台账，其条目 id 集合 = 章程标题集合。 */
async function constitutionGate(ctx: ChangeCtx, stage: Stage): Promise<Verdict> {
  const text = await readText(ctx.paths.constitution);
  if (text === null) return { passed: false, reasons: ['章程不存在'], accepted: [] };
  let titles: string[];
  try {
    titles = constitutionTitles(text);
  } catch (error) {
    return { passed: false, reasons: [(error as Error).message], accepted: [] };
  }
  if (!stage.ledgers.includes('constitution-reply')) return { passed: true, reasons: [], accepted: [] };
  const replyText = await readText(ctx.change.ledger('constitution-reply'));
  if (replyText === null) return { passed: false, reasons: ['章程答复台账不存在'], accepted: [] };
  let reply: Ledger;
  try {
    reply = parseYaml<Ledger>(replyText, 'ledger', 'constitution-reply');
  } catch (error) {
    return { passed: false, reasons: [(error as Error).message], accepted: [] };
  }
  const got = new Set(reply.entries.map((e) => e.id));
  const reasons: string[] = [];
  for (const t of titles) if (!got.has(t)) reasons.push(`缺条目「${t}」`);
  for (const id of got) if (!titles.includes(id)) reasons.push(`条目「${id}」不是章程标题`);
  return { passed: reasons.length === 0, reasons, accepted: [] };
}

/** spec-delta / interface-delta：操作块合法；MODIFIED/REMOVED 的 id 在基线里，ADDED 的不在。 */
async function deltaGate(ctx: ChangeCtx, which: 'spec' | 'interface'): Promise<Verdict> {
  const deltaDir = which === 'spec' ? ctx.change.specDeltaDir : ctx.change.interfaceDeltaDir;
  const files = await fg('**/*.md', { cwd: deltaDir, onlyFiles: true }).catch(() => [] as string[]);
  const reasons: string[] = [];
  for (const f of files.sort()) {
    const [group] = f.split('/');
    const indexPath = which === 'spec' ? ctx.paths.specsDomainIndex(group!) : ctx.paths.interfacesModuleIndex(group!);
    const known = new Set<string>();
    if (await exists(indexPath)) for (const e of (await readYaml<BaselineEntries>(indexPath, 'baseline-entries')).entries) known.add(e.id);
    const ops = deltaOps((await readText(join(deltaDir, f))) ?? '');
    for (const b of ops.added) if (known.has(b.id)) reasons.push(`${f}: ADDED 的 ${b.id} 已在基线里`);
    for (const b of [...ops.modified, ...ops.removed]) if (!known.has(b.id)) reasons.push(`${f}: ${b.id} 不在基线里`);
    if (which === 'interface') for (const b of [...ops.modified, ...ops.removed]) if (b.breaking === undefined) reasons.push(`${f}: ${b.id} 缺 breaking 字段`);
    if (!ops.added.length && !ops.modified.length && !ops.removed.length) reasons.push(`${f}: 没有任何操作块`);
  }
  return { passed: reasons.length === 0, reasons, accepted: [] };
}

/** interface-compat：breaking: true 的元素要求声明的影响面含 interface。 */
async function compatGate(ctx: ChangeCtx): Promise<Verdict> {
  const files = await fg('**/*.md', { cwd: ctx.change.interfaceDeltaDir, onlyFiles: true }).catch(() => [] as string[]);
  const reasons: string[] = [];
  for (const f of files) {
    const ops = deltaOps((await readText(join(ctx.change.interfaceDeltaDir, f))) ?? '');
    const breaking = [...ops.modified, ...ops.removed].filter((b) => b.breaking);
    if (breaking.length && !ctx.declaration.impact.includes('interface')) reasons.push(`${f}: ${breaking.map((b) => b.id).join('、')} 是破坏性变更，但声明的影响面没有 interface`);
  }
  return { passed: reasons.length === 0, reasons, accepted: [] };
}
