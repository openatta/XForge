// design: cli §2.1 — 定向的两段：0a 不变量（确定性、有界）与 1 级本站切片（自称完整）。
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import fg from 'fast-glob';
import { join } from 'node:path';
import { exists, readText } from '../fs/transaction.js';
import { enforcementAvailable } from '../hosts/index.js';
import { isIsolated, isOwed } from '../model/flow.js';
import { constitutionTitles, headings } from '../model/markdown.js';
import { DEFAULT_SCHEME } from '../model/paths.js';
import type { BaselineDomains, BaselineEntries, Flow, Stage } from '../model/types.js';
import { readYaml } from '../model/yaml.js';
import { artifactPath, owedItems, type ChangeCtx, type Project } from './context.js';

export interface Invariants {
  governance: { spec: boolean; interface: boolean; assurance: boolean };
  modules: Array<{ id: string; paths: string[] }>;
  flow: { name: string; stages: string[]; graph: Record<string, { gates: string[]; exit: string[]; rework_to: string[] }> };
  spec_domains: Array<{ id: string; title: string; capabilities: string[] }>;
  constitution: string[];
  declaration: { id: string; flow: string; risk: string; impact: string[] } | null;
  enforcement: 'available' | 'unavailable';
  call_skeleton: string[];
}

export async function invariants(project: Project, flow: Flow, ctx: ChangeCtx | null): Promise<Invariants> {
  const m = project.manifest;
  const graph: Invariants['flow']['graph'] = {};
  for (const s of flow.stages) {
    graph[s.id] = { gates: s.gates, exit: s.exit.map(exitLabel), rework_to: s.rework_to };
  }
  const domains: Invariants['spec_domains'] = [];
  if (m.governance.spec && (await exists(project.paths.specsIndex))) {
    const idx = await readYaml<BaselineDomains>(project.paths.specsIndex, 'baseline-domains');
    for (const d of idx.domains) domains.push({ id: d.id, title: d.title, capabilities: d.capabilities.map((c) => c.id) });
  }
  const constitutionText = await readText(project.paths.constitution);
  let constitution: string[] = [];
  try {
    constitution = constitutionText ? constitutionTitles(constitutionText) : [];
  } catch {
    constitution = [];
  }
  return {
    governance: { spec: m.governance.spec, interface: m.governance.interface, assurance: m.governance.spec || m.governance.interface },
    modules: m.modules,
    flow: { name: flow.name, stages: flow.stages.map((s) => s.id), graph },
    spec_domains: domains,
    constitution,
    declaration: ctx ? { id: ctx.declaration.id, flow: ctx.declaration.flow, risk: ctx.declaration.risk, impact: ctx.declaration.impact } : null,
    enforcement: enforcementAvailable(m.platforms) ? 'available' : 'unavailable',
    call_skeleton: ['xforge state', 'xforge show <ref>（需要正文时）', 'xforge attest …（本站有人的介入点时）', 'xforge advance'],
  };
}

function exitLabel(c: Stage['exit'][number]): string {
  switch (c.kind) {
    case 'gate':
    case 'ledger':
    case 'attested':
      return `${c.kind}:${c.ref}`;
    case 'approval':
      return `approval:${c.policy}`;
    default:
      return c.kind;
  }
}

export interface StageSlice {
  id: string;
  skill: string;
  /** 产出与台账的路径相对这个目录（项目根相对）；规格侧（side: spec）的在 Change 根，具名方案下两者不同。 */
  dir: string;
  human: string;
  isolate: boolean;
  produces: Array<{ id: string; path: string; side: string; read: string; status: string; because?: string; outline?: string[]; markers?: Array<{ kind: string; min: number }>; instructions?: string; draft?: string }>;
  ledgers: Array<{ kind: string; path: string; status: string; draft?: string }>;
  gates: string[];
  exit: string[];
  upstream: Array<{ path: string; bytes: number; headings: string[]; changed_since_last_state: boolean; ref: string }>;
  entries_in_touched_domains: Array<{ id: string; title: string }>;
  /** 这一站是被打回来的：从哪站、为什么、哪一环。不带的话执行者不知道自己在返工。 */
  rework?: { from: string; reason: string; receipt: string };
  complete: true;
}

export async function stageSlice(ctx: ChangeCtx, stage: Stage): Promise<StageSlice> {
  const owed = await owedItems(ctx, stage);
  const produces: StageSlice['produces'] = stage.produces.map((p) => {
    const o = owed.find((i) => i.kind === 'artifact' && i.id === p.id);
    const item: StageSlice['produces'][number] = { id: p.id, path: p.path, side: p.side, read: p.read, status: o?.status ?? 'pending' };
    if (o?.because) item.because = o.because;
    if (o?.status !== 'not-owed') {
      if (p.outline) item.outline = p.outline;
      if (p.markers) item.markers = p.markers;
      if (p.instructions) item.instructions = p.instructions;
      const draft = artifactDraft(p.path, ctx);
      if (draft && o?.status === 'pending') item.draft = draft;
    }
    return item;
  });
  const ledgers: StageSlice['ledgers'] = owed
    .filter((i) => i.kind === 'ledger')
    .map((i) => {
      const item: StageSlice['ledgers'][number] = { kind: i.id, path: i.path, status: i.status };
      if (i.status === 'pending' && !i.id.startsWith('delivery:')) item.draft = ledgerDraft(i.id, { constitution: constitutionTitlesOf(ctx), gates: stage.gates });
      return item;
    });
  const lastAt = ctx.receipts.at(-1)?.at;
  const upstream: StageSlice['upstream'] = [];
  const index = ctx.flow.stages.findIndex((s) => s.id === stage.id);
  for (const prior of ctx.flow.stages.slice(0, index)) {
    for (const p of prior.produces) {
      if (!isOwed(p, ctx.open, ctx.scheme === DEFAULT_SCHEME) || !p.path.endsWith('.md')) continue;
      const path = artifactPath(ctx.change, p.path);
      const text = await readText(path);
      if (text === null) continue;
      const info = await stat(path);
      upstream.push({ path: p.path, bytes: Buffer.byteLength(text), headings: headings(text, 2), changed_since_last_state: lastAt ? info.mtime.toISOString() > lastAt : true, ref: `doc:${p.path}` });
    }
  }
  const slice: StageSlice = {
    id: stage.id,
    skill: stage.skill,
    dir: ctx.change.implRel,
    human: stage.human,
    isolate: isIsolated(stage),
    produces,
    ledgers,
    gates: stage.gates,
    exit: stage.exit.map(exitLabel),
    upstream,
    entries_in_touched_domains: await touchedEntries(ctx),
    complete: true,
  };
  const lastMove = [...ctx.receipts].reverse().find((r) => r.kind === 'stage-transition' || r.kind === 'rework');
  if (lastMove?.kind === 'rework' && lastMove.to === stage.id) {
    slice.rework = { from: lastMove.from, reason: String(lastMove.subject['reason'] ?? ''), receipt: lastMove.id };
  }
  return slice;
}

/**
 * 台账骨架（起草是一种输出形态）：机器已知的部分填好（章程标题、本站的门），
 * 断言字段留空，取值范围写在注释里，Agent 不必去查 schema。
 */
export function ledgerDraft(kind: string, known: { constitution?: string[]; gates?: string[] } = {}): string {
  if (kind === 'review-findings') {
    return [
      'kind: review-findings',
      'conclusion: <这次评审覆盖了哪几个维度，可选>',
      'entries:',
      '  - id: F-001                # F-nnn',
      '    conclusion: open         # open | resolved | rejected；resolved / rejected 由人决定并署名',
      '    refs: [<路径#标题 或 Requirement id>]',
      '    note: <发现的内容与依据>',
      '',
    ].join('\n');
  }
  if (kind === 'constitution-reply') {
    const titles = known.constitution ?? [];
    const entries = titles.length
      ? titles.map((t) => `  - id: ${t}\n    conclusion: complies     # complies | violates | n-a；violates 需人署名批准\n    refs: [<Requirement id、路径或门名>]\n    note: <理由；n-a 要说得出为什么不适用>`).join('\n')
      : '  - id: <章程标题>\n    conclusion: complies     # complies | violates | n-a\n    refs: []';
    return `kind: constitution-reply\nentries:                     # 每条章程一条，id 就是章程标题\n${entries}\n`;
  }
  if (kind === 'verification-receipt') {
    const gates = known.gates ?? [];
    const entries = gates.length
      ? gates.map((g) => `  - id: ${g}\n    conclusion: passed\n    refs: [evidence/gates/${g}/<run>.yaml]`).join('\n')
      : '  - id: <门名>\n    conclusion: passed\n    refs: [evidence/gates/<门名>/<run>.yaml]';
    return `kind: verification-receipt   # 每道门一条；signer / at 由签署的人在登记前补上\nentries:\n${entries}\n`;
  }
  if (kind.startsWith('exit/')) {
    return [
      `kind: ${kind}`,
      'entries:',
      '  - id: Q-001                # 一条材料问题',
      '    conclusion: answered     # 由条件定义；材料问题：answered | deferred',
      '    refs: [<它影响的提案段落，如 proposal.md#目标>]',
      '    note: <问题、默认答案、最终答案>',
      '',
    ].join('\n');
  }
  return `kind: ${kind}\nentries: []\n`;
}

function constitutionTitlesOf(ctx: ChangeCtx): string[] {
  try {
    const text = readFileSync(ctx.paths.constitution, 'utf8');
    return text ? constitutionTitles(text) : [];
  } catch {
    return [];
  }
}

/** 条目级产出的骨架：形状由 schema 定死，Agent 只填内容（起草是一种输出形态）。 */
export function artifactDraft(path: string, ctx: ChangeCtx): string | null {
  if (path.endsWith('scope.yaml')) return `scheme: ${ctx.scheme}\npaths: []            # 本方案会动的路径 glob，如 src/**、tests/**\n`;
  if (path.endsWith('work-packages.yaml')) {
    const gate = ctx.manifest.selected.gates.includes('unit-tests') ? 'unit-tests' : '<命令门名>';
    return [
      'packages:',
      '  - id: P-01                 # 形如 P-nn',
      '    title: <一句话>',
      '    depends_on: []           # 其它包的 id',
      '    paths: []                # ⊆ scope.paths；glob 或具体文件',
      `    verify: {gate: ${gate}}   # 一道命令门`,
      '    criteria:',
      '      - {id: C-1, text: <可验证的完成判据>}',
      '    review: none             # none | required',
      '',
    ].join('\n');
  }
  if (path.endsWith('change.yaml')) return null;
  return null;
}

/** 本 Change 的 delta 目录里出现的域，其条目层索引（只在规格治理打开时）。 */
async function touchedEntries(ctx: ChangeCtx): Promise<Array<{ id: string; title: string }>> {
  if (!ctx.manifest.governance.spec) return [];
  const dirs = await fg('*', { cwd: ctx.change.specDeltaDir, onlyDirectories: true }).catch(() => [] as string[]);
  const out: Array<{ id: string; title: string }> = [];
  for (const d of dirs.sort()) {
    const idx = join(ctx.paths.specs, d, 'index.yaml');
    if (!(await exists(idx))) continue;
    for (const e of (await readYaml<BaselineEntries>(idx, 'baseline-entries')).entries) out.push({ id: e.id, title: e.title });
  }
  return out;
}
