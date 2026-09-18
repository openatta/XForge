// design: cli §5.6 — repair：把 doctor 找到的、重写一遍就能好的事做掉，其余原样报出来。
import { relative } from 'node:path';
import type { Outcome } from '../cli/envelope.js';
import { readText, Transaction } from '../fs/transaction.js';
import type { EnvelopeDiagnostic, Platform } from '../model/types.js';
import { context, findings, fixableChecks, nextFor, resultOf, runChecks, type CheckResult, type CheckRun } from './doctor.js';

export interface RepairResult {
  /** 从「有问题」变成「没问题」的项：修好的，以及跟着好起来的（孤儿随 Skill 补回而消失）。 */
  repaired: string[];
  /** 没解决的：修不了的与修了没成的，每项一句为什么。 */
  unfixable: Array<{ id: string; why: string }>;
  /** 修完之后重新体检的结果（与 `doctor` 同一个形状）。 */
  results: CheckResult[];
  problems: number;
}

const sick = (runs: readonly CheckRun[], id: string): boolean => runs.some((r) => r.check.id === id && r.found.length > 0);

/**
 * 修：补骨架 + 重投影，写入**同一个事务**（要么都成，要么都不动），修完重跑检查。
 * 可修的项**无条件跑一遍**：补骨架本就只在缺文件时动手，重投影是「投影 = 脚手架的函数」的重算 ——
 * 刚补回来的 Skill 与钩子，这一轮就得投影出去（不跑这一遍，它要等下一次 sync）。
 * 不看结果不算修好 —— 一次没落盘的修复比不修更坏，调用方会以为好了。
 */
export async function repair(root: string, only: readonly Platform[], env: NodeJS.ProcessEnv): Promise<Outcome<RepairResult>> {
  const ctx = await context(root, only, env);
  const before = await runChecks(ctx);
  const diagnostics: EnvelopeDiagnostic[] = [];

  const tx = new Transaction(root, ctx.paths.txDir);
  for (const check of fixableChecks()) diagnostics.push(...(await check.fix(ctx, tx)));
  const changed = await tx.commit();

  // 写完之后按盘上对一遍：写入没落到盘上（只读、权限、别人占着）在这里现形，而不是被当成修好了。
  for (const [path, content] of tx.pending()) {
    if ((await readText(path)) === content) continue;
    diagnostics.push({
      code: 'XF-REPAIR-002',
      severity: 'blocking',
      message: `${relative(root, path)} 写进去又变了：这次写入没落到盘上`,
      remedy: { text: '看那个位置是不是只读、权限不对，或者被别的进程占着' },
    });
  }

  // 重跑是**重算现场**再查，不是拿修之前算好的那份投影重比：修之前的投影里没有刚补回来的 Skill，
  // 拿它当判据，孤儿检查会把刚投出去的 Skill 目录说成没人认领。
  const after = await runChecks(await context(root, only, env));
  const results = after.map(resultOf);
  diagnostics.push(...after.flatMap(findings));

  return {
    result: {
      repaired: after.filter((r) => r.found.length === 0 && sick(before, r.check.id)).map((r) => r.check.id),
      unfixable: after.filter((r) => r.found.length > 0 && r.check.severity === 'blocking').map((r) => ({ id: r.check.id, why: r.check.why })),
      results,
      problems: results.filter((r) => r.status === 'fail').length,
    },
    diagnostics,
    changed,
    next: nextFor(results),
  };
}
