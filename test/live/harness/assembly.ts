// design: live-test §3 — LT-09/LT-10/LT-11：在真实装好的包与真实跑过的树上，把装配面的「验」与「修」各走一遍。
import type { Envelope } from '../../../src/model/types.js';
import { xforge } from './xforge.js';

/** 一次装配体检的结论。三段各一次 `xforge` 调用，结论由下面的纯函数从信封算出来。 */
export interface AssemblyCheck {
  /** 跑完一整个场景之后，这棵树上 `doctor` 报了哪些非 info 的码。 */
  codes: string[];
  /** `doctor` 的退出码。 */
  exit: number;
  /** `doctor` 写盘了没有 —— 它是「验」，恒该为空。 */
  wrote: string[];
  /** 注入一处漂移之后 `repair` 修没修回来，以及修完 `doctor` 还剩什么。 */
  repair: { changed: number; leftCodes: string[]; exit: number } | null;
}

const problemCodes = (env: Envelope): string[] => [...new Set(env.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.code))].sort();

/**
 * 从三份信封算结论。**纯函数** —— product 层直接喂样例信封测它，
 * 不用等一次真机运行（同 `renderSummary` 的路子）。
 */
export function readAssembly(doctor: Envelope, doctorExit: number, repaired: { env: Envelope; exit: number } | null, after: Envelope | null): AssemblyCheck {
  const out: AssemblyCheck = { codes: problemCodes(doctor), exit: doctorExit, wrote: doctor.changed, repair: null };
  if (repaired && after) {
    out.repair = { changed: repaired.env.changed.length, leftCodes: problemCodes(after), exit: repaired.exit };
  }
  return out;
}

/** 这一次运行的装配面有没有问题，用于 `meetsExpectation`：每一条都说出是哪里不对。 */
export function assemblyProblems(a: AssemblyCheck): string[] {
  const problems: string[] = [];
  // LT-09：真机上跑完一整个场景之后，装配本身应当还是干净的。
  if (a.codes.length) problems.push(`doctor 报了 ${a.codes.join('、')}`);
  if (a.exit !== 0) problems.push(`doctor 退出码 ${a.exit}`);
  // LT-10：doctor 是「验」，写盘就是它自己坏了。
  if (a.wrote.length) problems.push(`doctor 写了盘：${a.wrote.join('、')}`);
  // LT-11：注入的漂移要被修回来，且修完不留新问题。
  if (a.repair) {
    if (!a.repair.changed) problems.push('repair 没有改动任何文件，但树上注入过漂移');
    if (a.repair.leftCodes.length) problems.push(`repair 之后仍有 ${a.repair.leftCodes.join('、')}`);
    if (a.repair.exit !== 0) problems.push(`repair 退出码 ${a.repair.exit}`);
  }
  return problems;
}

/**
 * 真机上跑一遍：`doctor` → 注入一处漂移 → `repair` → `doctor`。
 * 这里只负责调命令与搬字段，判定全在上面两个纯函数里 —— 没被测到的面要尽量薄。
 */
export async function probeAssembly(project: string, drift: (() => void) | null): Promise<AssemblyCheck> {
  const first = await xforge(project, ['doctor']);
  if (!drift) return readAssembly(first.env, first.exit, null, null);
  drift();
  const repaired = await xforge(project, ['repair']);
  const after = await xforge(project, ['doctor']);
  return readAssembly(first.env, first.exit, { env: repaired.env, exit: repaired.exit }, after.env);
}
