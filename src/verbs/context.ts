// design: cli §1.2 — 每次调用从磁盘重新解析：项目、清单、Change、流程、链、计划、作用域、投影。
import { readdir } from 'node:fs/promises';
import { CliError } from '../cli/errors.js';
import { eventsFor, readChain } from '../audit/chain.js';
import { exists, readText } from '../fs/transaction.js';
import { packageStates, readReceipts, stagePosition, type PackageState, type Position } from '../machines/receipts.js';
import { ModelError } from '../model/errors.js';
import { isOwed, openNeeds, stageById, validateFlow } from '../model/flow.js';
import { artifactPathOf, DEFAULT_SCHEME, findProjectRoot, governancePaths, type ChangePaths, type GovernancePaths } from '../model/paths.js';
import { isSchemeId } from '../model/ids.js';
import type { AuditEvent, AuditIndex, ChangeDeclaration, Flow, Manifest, Need, Projection, Receipt, Scope, Stage, WorkPackages } from '../model/types.js';
import { readYaml } from '../model/yaml.js';
import { readProjections } from '../projection/index.js';

export interface Project {
  root: string;
  paths: GovernancePaths;
  manifest: Manifest;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => string;
}

export async function loadProject(cwd: string, env: NodeJS.ProcessEnv): Promise<Project> {
  const root = await findProjectRoot(cwd, env);
  if (!root) throw new CliError('XF-STATE-002', '找不到治理根（xforge/manifest.yaml）', 3, { command: 'xforge init', text: '在项目根初始化，或到项目目录里再跑' });
  const paths = governancePaths(root);
  const manifest = await modelToCli(() => readYaml<Manifest>(paths.manifest, 'manifest'));
  const fixedNow = env['XFORGE_NOW'];
  return { root, paths, manifest, env, cwd, now: () => fixedNow ?? new Date().toISOString() };
}

export interface ChangeCtx extends Project {
  changeId: string;
  scheme: string;
  change: ChangePaths;
  declaration: ChangeDeclaration;
  flow: Flow;
  receipts: Receipt[];
  position: Position;
  plan: WorkPackages | null;
  scope: Scope | null;
  packages: Map<string, PackageState>;
  chain: AuditEvent[];
  events: AuditEvent[];
  auditIndex: AuditIndex;
  projections: Projection[];
  open: Set<Need>;
  /** 声明层文件形状不对：不是损坏，是待改；state 报成阻塞，advance 不放行。 */
  problems: Array<{ ref: string; message: string }>;
}

/** 未归档的 Change 目录名列表（有 change.yaml 且没有 archive receipt）。 */
export async function listOpenChanges(paths: GovernancePaths): Promise<string[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(paths.changes, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  const open: string[] = [];
  for (const id of dirs) {
    const cp = paths.change(id);
    if (!(await exists(cp.declaration))) continue;
    if (!(await isArchived(cp))) open.push(id);
  }
  return open;
}

/** 归档是 Change 级：Change 根有标记，或（老项目）默认方案的链上有 archive receipt。 */
export async function isArchived(cp: ChangePaths): Promise<boolean> {
  if (await exists(cp.archiveMarker)) return true;
  try {
    return (await readdir(cp.receiptsDir)).some((f) => f.endsWith('-archive.yaml'));
  } catch {
    return false;
  }
}

/** Change 目录下的具名方案：子目录名合法且不是规格侧/实现侧的固定名字。 */
export async function listSchemes(cp: ChangePaths): Promise<string[]> {
  try {
    return (await readdir(cp.root, { withFileTypes: true })).filter((d) => d.isDirectory() && isSchemeId(d.name)).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

export async function resolveChangeId(project: Project, requested: string | undefined): Promise<string | null> {
  if (requested) {
    if (!(await exists(project.paths.change(requested).declaration))) {
      throw new CliError('XF-STATE-001', `Change ${requested} 不存在`, 2, { command: 'xforge state', text: '不带 --change 看有哪些' });
    }
    return requested;
  }
  const open = await listOpenChanges(project.paths);
  if (open.length === 0) return null;
  if (open.length > 1) {
    throw new CliError('XF-STATE-001', `有 ${open.length} 个未归档的 Change：${open.join('、')}`, 2, { command: 'xforge state --change <id>', text: '带上 --change' });
  }
  return open[0]!;
}

export async function loadChange(project: Project, requested: string | undefined, scheme = DEFAULT_SCHEME): Promise<ChangeCtx | null> {
  if (scheme !== DEFAULT_SCHEME && !isSchemeId(scheme)) {
    throw new CliError('XF-STATE-001', `方案 id ${scheme} 不合法：小写字母开头的字母数字与连字符，且不能是 specs/interfaces/ledgers/evidence`, 2, { text: '换一个方案 id' });
  }
  const changeId = await resolveChangeId(project, requested);
  if (!changeId) return null;
  const change = project.paths.change(changeId, scheme);
  const declaration = await modelToCli(() => readYaml<ChangeDeclaration>(change.declaration, 'change'));
  if (declaration.id !== changeId) {
    throw new CliError('XF-MODEL-001', `change.yaml 的 id（${declaration.id}）与目录名（${changeId}）不一致`, 3, { text: '目录名就是 Change id' });
  }
  const flow = await loadFlow(project, declaration.flow);
  if (!flow.eligibility.risk.includes(declaration.risk)) {
    throw new CliError('XF-STATE-004', `流程 ${flow.name} 只接受风险等级 ${flow.eligibility.risk.join('、')}，声明的是 ${declaration.risk}`, 1, { text: '换一条接受这个风险等级的流程，或改声明的 risk' });
  }
  const receipts = await readReceipts(change);
  const problems: Array<{ ref: string; message: string }> = [];
  const soft = async <T,>(path: string, schema: 'work-packages' | 'scope', ref: string): Promise<T | null> => {
    if (!(await exists(path))) return null;
    try {
      return await readYaml<T>(path, schema);
    } catch (error) {
      if (error instanceof ModelError) {
        problems.push({ ref, message: `${error.message}${error.details.length ? `：${error.details.join('；')}` : ''}` });
        return null;
      }
      throw error;
    }
  };
  const plan = await soft<WorkPackages>(change.workPackages, 'work-packages', 'work-packages');
  const scope = await soft<Scope>(change.scope, 'scope', 'scope');
  const chain = await readChain(project.paths);
  const auditIndex = (await exists(change.auditIndex)) ? await modelToCli(() => readYaml<AuditIndex>(change.auditIndex, 'audit-index')) : { events: [] };
  const projections = await modelToCli(() => readProjections(change));
  // 归档是 Change 级：别的方案归档了，这个方案的位置也是 archived（冻结）。
  const position = (await exists(change.archiveMarker)) ? { stage: null, status: 'archived' as const } : stagePosition(flow, receipts);
  return {
    ...project,
    changeId,
    scheme,
    change,
    declaration,
    flow,
    receipts,
    position,
    plan,
    scope,
    packages: packageStates(plan, receipts),
    chain,
    // 终局审批按 Change 收：archive 主题的事件对每个方案都可见。
    events: eventsFor(chain, changeId, scheme, { includeArchive: true, sharedStages: flow.stages.filter((s) => s.scope === 'change').map((s) => s.id) }),
    auditIndex,
    projections,
    open: openNeeds(project.manifest),
    problems,
  };
}

export async function loadFlow(project: Project, name: string): Promise<Flow> {
  if (!project.manifest.selected.flows.includes(name)) {
    throw new CliError('XF-MODEL-002', `流程 ${name} 不在清单 selected.flows 里`, 3, { text: '把它加进清单，或换一条流程' });
  }
  const flow = await modelToCli(() => readYaml<Flow>(project.paths.flow(name), 'flow'));
  const errors = validateFlow(flow);
  if (errors.length) throw new CliError('XF-MODEL-001', `流程 ${name} 不自洽`, 3, undefined, errors);
  return flow;
}

export function currentStage(ctx: ChangeCtx): Stage | null {
  if (!ctx.position.stage) return null;
  return stageById(ctx.flow, ctx.position.stage) ?? null;
}

export function requireStage(ctx: ChangeCtx): Stage {
  const stage = currentStage(ctx);
  if (!stage) {
    const where = ctx.position.status === 'archived' ? '已归档' : 'ready-to-archive';
    throw new CliError('XF-ADVANCE-001', `Change 在 ${where}，没有当前站`, 1, { command: 'xforge state', text: '看位置' });
  }
  return stage;
}

export interface OwedItem {
  id: string;
  kind: 'artifact' | 'ledger';
  status: 'pending' | 'present' | 'not-owed';
  path: string;
  because?: string;
}

/** 本站欠什么：产出与台账；`不欠不是待写`。 */
export async function owedItems(ctx: ChangeCtx, stage: Stage): Promise<OwedItem[]> {
  const out: OwedItem[] = [];
  for (const p of stage.produces) {
    const path = artifactPath(ctx.change, p.path);
    const rel = p.path;
    if (!isOwed(p, ctx.open, ctx.scheme === DEFAULT_SCHEME)) {
      const missing = (p.needs ?? []).filter((n) => !ctx.open.has(n));
      out.push({ id: p.id, kind: 'artifact', status: 'not-owed', path: rel, because: missing.length ? `governance.${missing.join('+')}=false` : 'side=spec, non-default scheme' });
      continue;
    }
    out.push({ id: p.id, kind: 'artifact', status: (await exists(path)) ? 'present' : 'pending', path: rel });
  }
  for (const ref of stage.ledgers) {
    if (ref === 'delivery') {
      for (const pkg of ctx.plan?.packages ?? []) {
        const path = ctx.change.ledger('delivery', pkg.id);
        out.push({ id: `delivery:${pkg.id}`, kind: 'ledger', status: (await exists(path)) ? 'present' : 'pending', path: `ledgers/deliveries/${pkg.id}.yaml` });
      }
      continue;
    }
    const path = ctx.change.ledger(ref);
    out.push({ id: ref, kind: 'ledger', status: (await exists(path)) ? 'present' : 'pending', path: `ledgers/${ref}.yaml` });
  }
  return out;
}

/** 本方案此刻的工作目录：进站投影记下的 workdir；没有投影就是项目根。命令门、无归属判定、交付核对都在这里做。 */
export function workdirOf(ctx: ChangeCtx): string {
  return ctx.projections.find((p) => p.kind === 'stage' && p.closed_by === null)?.workdir ?? ctx.root;
}

/** 产出路径：以 `/` 结尾的是目录（delta 目录），否则是文件；规格侧在 Change 根，实现侧在本方案目录。 */
export function artifactPath(change: ChangePaths, rel: string): string {
  return artifactPathOf(change, rel);
}

export async function readArtifact(change: ChangePaths, rel: string): Promise<string | null> {
  return readText(artifactPath(change, rel));
}

export async function modelToCli<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ModelError) throw new CliError(error.code, error.message, 3, { text: '按诊断里的路径与字段改文件' }, error.details);
    throw error;
  }
}
