// design: cli §5.5 — repair：把 doctor 报的、能自动修的修掉。修法只有一个：按当前脚手架重投出问题的那些 provider。
import type { Outcome } from '../cli/envelope.js';
import type { GovernancePaths } from '../model/paths.js';
import type { EnvelopeDiagnostic, Manifest } from '../model/types.js';
import { doctorReport, REPAIRABLE, type Finding } from './doctor.js';

export interface RepairResult {
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
  const wanted = (f: Finding): boolean => REPAIRABLE.has(f.code) && (opts.only.length === 0 || opts.only.includes(f.code));

  // 标记块坏了的 provider 这一轮整个不碰：块的边界已经不可信，投影会毁掉块外的内容。
  const untouchable = new Set(problems.filter((f) => f.code === 'XF-ASSEMBLE-010').map((f) => f.provider).filter((id): id is string => id !== undefined));
  const targets = [...new Set(problems.filter(wanted).map((f) => f.provider).filter((id): id is string => id !== undefined && !untouchable.has(id)))].sort();
  const willFix = problems.filter((f) => wanted(f) && f.provider !== undefined && targets.includes(f.provider));

  if (opts.dryRun || targets.length === 0) {
    const planned = new Set(willFix.map(key));
    const left = problems.filter((f) => !planned.has(key(f)));
    return {
      result: { repaired: opts.dryRun ? targets : [], fixed: [], left: left.map(ref), dry_run: opts.dryRun },
      changed: [],
      diagnostics: opts.dryRun ? [...willFix.map((f) => ({ ...strip(f), severity: 'info' as const, message: `会修：${f.message}` })), ...left.map(strip)] : left.map(strip),
      next: opts.dryRun && targets.length ? [{ command: 'xforge repair', why: '真的修' }] : [],
    };
  }

  const synced = await opts.reproject(targets);
  const after = await doctorReport(root, paths, manifest, env, undefined);
  const left = after.findings.filter((f) => f.severity !== 'info');
  const still = new Set(left.map(key));
  const fixed = willFix.filter((f) => !still.has(key(f)));

  return {
    result: { repaired: targets, fixed: fixed.map(ref), left: left.map(ref), dry_run: false },
    changed: synced.changed,
    diagnostics: [...synced.diagnostics.filter((d) => d.severity === 'blocking'), ...left.map(strip)],
    next: left.length ? [{ command: 'xforge doctor', why: '还有只能人处理的发现' }] : [],
  };
}

function strip(f: Finding): EnvelopeDiagnostic {
  const { subject: _subject, provider: _provider, ...d } = f;
  return d;
}
