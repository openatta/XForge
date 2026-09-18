// design: cli §5.5 — repair：把 doctor 报的、能自动修的修掉。两步：从载荷补回缺的受管文件，再重投出问题的 provider。
import type { Outcome } from '../cli/envelope.js';
import { Transaction } from '../fs/transaction.js';
import { payloadDir } from '../meta/index.js';
import type { GovernancePaths } from '../model/paths.js';
import type { EnvelopeDiagnostic, Manifest } from '../model/types.js';
import { doctorReport, REPAIRABLE, SCAFFOLD_CODE, type Finding } from './doctor.js';
import { backfillable, backfillScaffold, scaffoldIssues } from './scaffold.js';

export interface RepairResult {
  /** 这一轮从载荷补回来的受管文件（相对 scaffold/）。 */
  restored: string[];
  /** 这一轮重投的 provider。 */
  repaired: string[];
  /** 修掉的发现：码 + 对象。 */
  fixed: Array<{ code: string; subject: string }>;
  /** 留给人的发现。 */
  left: Array<{ code: string; subject: string }>;
  dry_run: boolean;
}

export interface RepairOptions {
  only: readonly string[];
  dryRun: boolean;
  /** 重投一组 provider；由装配入口注入 sync，两个模块不互相 import。 */
  reproject: (ids: readonly string[]) => Promise<{ changed: string[]; diagnostics: EnvelopeDiagnostic[] }>;
}

const key = (f: Finding): string => `${f.code} ${f.subject}`;
const ref = (f: Finding): { code: string; subject: string } => ({ code: f.code, subject: f.subject });

export async function runRepair(root: string, paths: GovernancePaths, manifest: Manifest, env: NodeJS.ProcessEnv, opts: RepairOptions): Promise<Outcome<RepairResult>> {
  const before = await doctorReport(root, paths, manifest, env, undefined);
  const problems = before.findings.filter((f) => f.severity !== 'info');
  const asked = (code: string): boolean => opts.only.length === 0 || opts.only.includes(code);
  const wanted = (f: Finding): boolean => REPAIRABLE.has(f.code) && asked(f.code);

  // 标记块坏了的 provider 这一轮整个不碰：块的边界已经不可信，投影会毁掉块外的内容。
  const untouchable = new Set(problems.filter((f) => f.code === 'XF-ASSEMBLE-010').map((f) => f.provider).filter((id): id is string => id !== undefined));
  const targets = [...new Set(problems.filter(wanted).map((f) => f.provider).filter((id): id is string => id !== undefined && !untouchable.has(id)))].sort();

  // 骨架先算：缺的能从载荷补回，改过的不动。补回来的 Skill 与钩子要在同一轮里投出去，所以它排在重投之前。
  const issues = asked(SCAFFOLD_CODE) ? (await scaffoldIssues(paths, manifest)).filter(backfillable) : [];
  const willFix = [
    ...problems.filter((f) => wanted(f) && f.provider !== undefined && targets.includes(f.provider)),
    ...problems.filter((f) => f.code === SCAFFOLD_CODE && issues.some((i) => i.subject === f.subject)),
  ];

  if (opts.dryRun) {
    const planned = new Set(willFix.map(key));
    const left = problems.filter((f) => !planned.has(key(f)));
    return {
      result: { restored: issues.map((i) => i.rel ?? i.subject), repaired: targets, fixed: [], left: left.map(ref), dry_run: true },
      changed: [],
      diagnostics: [...willFix.map((f) => ({ ...strip(f), severity: 'info' as const, message: `会修：${f.message}` })), ...left.map(strip)],
      next: willFix.length ? [{ command: 'xforge repair', why: '真的修' }] : [],
    };
  }

  if (!targets.length && !issues.length) {
    const left = problems;
    return { result: { restored: [], repaired: [], fixed: [], left: left.map(ref), dry_run: false }, changed: [], diagnostics: left.map(strip), next: [] };
  }

  // 1 补骨架。先落盘，下一步的投影才看得见补回来的东西。失败整体回滚，脚手架保持原样。
  const restored: string[] = [];
  const refusals: EnvelopeDiagnostic[] = [];
  let changed: string[] = [];
  if (issues.length) {
    const tx = new Transaction(root, paths.txDir);
    const backfill = await backfillScaffold(paths, payloadDir(), issues, tx);
    restored.push(...backfill.restored);
    refusals.push(...backfill.refused);
    changed = await tx.commit();
  }

  // 2 重投。投影是脚手架的函数，所以它排在补骨架之后。
  const synced = targets.length ? await opts.reproject(targets) : { changed: [], diagnostics: [] };
  changed = [...changed, ...synced.changed];

  // 3 按盘上再查一遍。「我改了」不等于「我改好了」—— 一次没落盘的修复比不修更坏。
  const after = await doctorReport(root, paths, manifest, env, undefined);
  const left = after.findings.filter((f) => f.severity !== 'info');
  const still = new Set(left.map(key));
  const fixed = willFix.filter((f) => !still.has(key(f)));
  const failed = willFix.filter((f) => still.has(key(f)));

  return {
    result: { restored, repaired: targets, fixed: fixed.map(ref), left: left.map(ref), dry_run: false },
    changed,
    diagnostics: [
      ...failed.map((f) => ({ code: 'XF-ASSEMBLE-016', severity: 'blocking' as const, message: `${f.subject} 修完之后还是不对：这次写入没落到该在的样子`, remedy: { text: '看那个路径的权限与占用；处理完再跑一次 xforge repair' } })),
      ...refusals,
      ...synced.diagnostics.filter((d) => d.severity === 'blocking'),
      ...left.map(strip),
    ],
    next: left.length ? [{ command: 'xforge doctor', why: '还有只能人处理的发现' }] : [],
  };
}

function strip(f: Finding): EnvelopeDiagnostic {
  const { subject: _subject, provider: _provider, ...d } = f;
  return d;
}
