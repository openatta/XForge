// design: cli §5.5 §5.6 — 检查表：doctor 拿它体检（只读），repair 拿它修（能修的那两项）。
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Outcome } from '../cli/envelope.js';
import { exists, readText, type Transaction } from '../fs/transaction.js';
import { enforceCommand, provider, type HostFile } from '../hosts/index.js';
import { cliVersion, payloadDir } from '../meta/index.js';
import { classifyFile, fileChecksum, INTEGRITY_FILE } from '../model/integrity.js';
import { governancePaths, type GovernancePaths } from '../model/paths.js';
import type { EnvelopeDiagnostic, Hook, Integrity, Manifest, Platform } from '../model/types.js';
import { parseYaml, readYaml } from '../model/yaml.js';
import { detectAll, onPath } from './detect.js';
import { projections, projectionContext, skillNames } from './projection.js';

export interface CheckResult {
  id: string;
  status: 'ok' | 'fail' | 'info';
  /** 不健康时说什么；`ok` 的项不带它。 */
  detail?: string;
}

export interface DoctorResult {
  results: CheckResult[];
  problems: number;
}

export interface Ctx {
  root: string;
  paths: GovernancePaths;
  manifest: Manifest;
  platforms: readonly Platform[];
  env: NodeJS.ProcessEnv;
  /** 这支 CLI 自带的载荷：`init` 从它复制，`repair` 从它补回缺的受管文件。 */
  payload: string;
  /** 这份体检针对的投影：算一次，几项检查看的是同一份（不然它们会各说各话）。 */
  files: readonly HostFile[];
  hook: Hook | null;
}

/**
 * 一项检查。`run` 回若干条说法，空数组 = 这一项没问题。
 * 说法按 `severity` 报出去：装配坏了不是「也许」，是「不行」，所以是 `blocking`
 * （`ok=false` ⇔ 退出码 1，CLI-02）；只有版本落后是 `info`，不改退出码。
 */
export interface Check {
  id: string;
  code: string;
  severity: 'blocking' | 'info';
  run(ctx: Ctx): Promise<string[]>;
  /**
   * 有它才是可修的：要写的写进 `tx`，由调用方一次提交（补骨架与重投影是一个事务）。
   * 修没修好**不由这里说** —— 由重跑 `run` 判定，别让「我改了」自己说「我改好了」。
   * 回的是修复过程自己要说的话（比如载荷里没有可信的副本），平时为空。
   */
  fix?(ctx: Ctx, tx: Transaction): Promise<EnvelopeDiagnostic[]>;
  /** 不动它的理由；可修的项，这句用在「修完还坏」的时候。 */
  why: string;
}

/** 完整性清单在项目里的说法；报错信息里用它，别在别处再造一个。 */
const GOVERNANCE_INTEGRITY = 'scaffold/integrity.yaml';

/** 1 宿主在场：清单选中了它，本机得真有它 —— 否则投影写得再对也没人读。 */
const hostCheck: Check = {
  id: 'host',
  code: 'XF-DOCTOR-001',
  severity: 'blocking',
  why: '装宿主不是 xforge 的事',
  async run(ctx) {
    return detectAll(ctx.platforms, ctx.env)
      .filter((d) => !d.presence.available)
      .map((d) => `宿主 ${d.id} 本机探测不到（清单里选中了它）`);
  },
};

/** 2 投影新鲜：把 sync 会写的每一份重新算一遍，与盘上逐字节比。 */
const projectionCheck: Check = {
  id: 'projection',
  code: 'XF-DOCTOR-002',
  severity: 'blocking',
  why: '重投影之后还是不一致：那个位置写不进去（只读、权限，或别的进程正占着）',
  async run(ctx) {
    const out: string[] = [];
    for (const f of ctx.files) if ((await readText(f.path)) !== f.content) out.push(`${relative(ctx.root, f.path)} 与 sync 会写的不一致`);
    return out;
  },
  async fix(ctx, tx) {
    // 从「盘上 + 事务里还没落盘的」算：这一轮刚补回来的 Skill 与钩子，投影得看得见。
    const context = await projectionContext(ctx.root, ctx.paths, ctx.manifest, tx.pending());
    for (const f of await projections(context, ctx.platforms)) {
      if ((await readText(f.path)) !== f.content) tx.write(f.path, f.content);
    }
    return [];
  },
};

/** 3 能力兑现：声明了钩子的宿主，钩子得真装上、命令得真能跑（D8：拦不住别假装拦得住）。 */
const capabilityCheck: Check = {
  id: 'capability',
  code: 'XF-DOCTOR-003',
  severity: 'blocking',
  why: 'PATH 是环境与安装方式的事、共享配置文件是别人写的，都要人来改',
  async run(ctx) {
    const out: string[] = [];
    const withHook = ctx.platforms.filter((p) => provider(p).capabilities.enforcement === 'hook');
    if (withHook.length === 0) return out;
    // 装了才算数：投影里没有这条命令 = 没装成（放钩子的共享文件读不懂，我们不动别人写的文件）。
    for (const p of withHook) {
      const expected = enforceCommand(ctx.hook, p);
      if (ctx.files.some((f) => f.content.includes(expected))) continue;
      out.push(`${p} 声明了执法钩子，但这次投影里没有它：${provider(p).hookFile ?? '宿主的共享配置文件'} 读不懂，钩子没能装进去`);
    }
    const command = enforceCommand(ctx.hook, withHook[0]!);
    const binary = command.split(' ')[0] ?? '';
    if (binary && !onPath(binary, ctx.env)) out.push(`${withHook.join('、')} 声明了执法钩子，但 ${binary} 不在 PATH 上：enforcement 会报 available 却拦不住`);
    return out;
  },
};

/** 4 骨架完整：完整性清单里的文件、钩子声明、清单语言对应的 Skill 源文件，都得在。 */
const scaffoldCheck: Check = {
  id: 'scaffold',
  code: 'XF-DOCTOR-004',
  severity: 'blocking',
  why: '只补缺的：被改过的正文是有人写过的，覆盖它得先问人（xforge update 会把它留在 incoming/ 里等你合并）',
  async run(ctx) {
    const out: string[] = [];
    const integrity = await readIntegrity(ctx, null);
    if (integrity) {
      for (const [file, checksum] of Object.entries(integrity.files)) {
        const cls = classifyFile(checksum, (await readText(join(ctx.paths.scaffold, file))) ?? undefined);
        if (cls === 'missing') out.push(`受管文件 ${file} 不在`);
        if (cls === 'modified') out.push(`受管文件 ${file} 在本地化区之外被改过`);
      }
    } else {
      out.push(`${GOVERNANCE_INTEGRITY} 不在，受管文件没法核对`);
    }
    if (!(await exists(ctx.paths.hook('enforce')))) out.push('scaffold/hooks/enforce.yaml 不在，投影会退回内置声明');
    // 载荷缺这一份时 sync 不报错，只是不投影那个 Skill —— 静默失效，所以在这里说。
    const specialized = ctx.manifest.language === 'zh-CN' ? 'SKILL_cn.md' : 'SKILL.md';
    for (const name of await skillNames(ctx.paths)) {
      if (!(await exists(join(ctx.paths.skillDir(name), specialized)))) out.push(`Skill ${name} 缺 ${specialized}（清单语言 ${ctx.manifest.language}）`);
    }
    return out;
  },
  /**
   * 补缺：缺的受管文件从载荷补回，**校验和对得上才补** —— 对不上说明载荷不是这份清单说的那一版
   * （多半是脚手架还停在旧版本），拿它覆盖就是把一份错的正文写进去。改过的到此为止，一个字不动。
   */
  async fix(ctx, tx) {
    const out: EnvelopeDiagnostic[] = [];
    const refuse = (rel: string, why: string): void => {
      out.push({
        code: 'XF-REPAIR-001',
        severity: 'blocking',
        message: `${rel} 补不回来：${why}`,
        remedy: { command: 'xforge update', text: '用新版载荷对齐骨架，再 repair' },
      });
    };
    const copyOf = async (rel: string): Promise<string | null> => readText(join(ctx.payload, rel));

    // 清单自己不在：先从载荷补它 —— 没有它，下面「该有什么」就没有依据。
    if (!(await exists(ctx.paths.integrity))) {
      const text = await copyOf(INTEGRITY_FILE);
      const version = text === null ? null : payloadVersionOf(text);
      if (text === null || version === null) refuse(GOVERNANCE_INTEGRITY, '载荷里没有可信的副本');
      else if (version !== ctx.manifest.scaffold.version) refuse(GOVERNANCE_INTEGRITY, `载荷里那份记的是骨架 ${version}，清单里是 ${ctx.manifest.scaffold.version}；凭它补文件会把不匹配说成「被改过」`);
      else tx.write(ctx.paths.integrity, text);
    }

    const integrity = await readIntegrity(ctx, tx.pending());
    for (const [rel, recorded] of Object.entries(integrity?.files ?? {})) {
      const path = join(ctx.paths.scaffold, rel);
      if (classifyFile(recorded, (await readText(path)) ?? undefined) !== 'missing') continue;
      const text = await copyOf(rel);
      if (text === null) refuse(rel, '载荷里没有副本');
      else if (fileChecksum(text) !== recorded) refuse(rel, '载荷里那份与完整性清单对不上（载荷版本与脚手架不同？）');
      else tx.write(path, text);
    }
    return out;
  },
};

/** 5 残留：没走完的升级、宿主里没人认领的孤儿。 */
const residueCheck: Check = {
  id: 'residue',
  code: 'XF-DOCTOR-005',
  severity: 'blocking',
  why: '在途升级要选收尾还是回退，孤儿文件删不删是人的决定',
  async run(ctx) {
    const out: string[] = [];
    if (existsSync(join(ctx.paths.upgradeDir, 'status.yaml'))) out.push('一次脚手架升级还在途（xforge/.upgrade/）');
    const projected = ctx.files.map((f) => f.path);
    for (const p of ctx.platforms) {
      for (const path of await provider(p).ownership(ctx.root)) {
        if (!(await stat(path).catch(() => null))) continue; // 投影里没有、宿主那边也没有：不是残留
        const claims = projected.some((f) => f === path || f.startsWith(path + sep));
        if (!claims) out.push(`${relative(ctx.root, path)} 已经没人认领（脚手架里没有对应的投影了）`);
      }
    }
    return out;
  },
};

/** 6 版本：只是提示，不改退出码 —— 项目可以刻意停在旧脚手架上。 */
const versionCheck: Check = {
  id: 'version',
  code: 'XF-DOCTOR-006',
  severity: 'info',
  why: '那是 xforge update 的事，而且它不算坏',
  async run(ctx) {
    const payload = cliVersion();
    return ctx.manifest.scaffold.version === payload ? [] : [`脚手架 ${ctx.manifest.scaffold.version}，本次载荷 ${payload}`];
  },
};

/** 检查表：顺序 = 报告顺序。 */
const CHECKS: readonly Check[] = [hostCheck, projectionCheck, capabilityCheck, scaffoldCheck, residueCheck, versionCheck];

/** 载荷里那份完整性清单记的骨架版本；读不出、不合法都算「没有可信的副本」。 */
function payloadVersionOf(text: string): string | null {
  try {
    return parseYaml<Integrity>(text, 'integrity', INTEGRITY_FILE).scaffold_version;
  } catch {
    return null;
  }
}

/** 完整性清单：事务里有还没落盘的那份就用它（刚补进去的），否则读盘；读不出回 null。 */
async function readIntegrity(ctx: Ctx, pending: ReadonlyMap<string, string> | null): Promise<Integrity | null> {
  const staged = pending?.get(ctx.paths.integrity);
  if (staged !== undefined) return parseYaml<Integrity>(staged, 'integrity', GOVERNANCE_INTEGRITY);
  try {
    return await readYaml<Integrity>(ctx.paths.integrity, 'integrity');
  } catch {
    return null;
  }
}

/**
 * 有 `fix` 的项，修的先后由依赖定、不由报告顺序定：投影是从脚手架算出来的，
 * 先补骨架，这一轮投影才看得见补回来的 Skill 与钩子。
 */
const FIX_ORDER: readonly string[] = ['scaffold', 'projection'];

/** 有 `fix` 的检查：`repair` 只碰这些。 */
export type FixableCheck = Check & { fix: NonNullable<Check['fix']> };

export function fixableChecks(): FixableCheck[] {
  return CHECKS.filter((c): c is FixableCheck => c.fix !== undefined).sort((a, b) => FIX_ORDER.indexOf(a.id) - FIX_ORDER.indexOf(b.id));
}

export interface CheckRun {
  check: Check;
  found: string[];
}

/** 跑一遍检查表。doctor 只要结果，repair 还要知道「修之前有什么」—— 同一份实现。 */
export async function runChecks(ctx: Ctx): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (const check of CHECKS) runs.push({ check, found: await check.run(ctx) });
  return runs;
}

export function resultOf(run: CheckRun): CheckResult {
  if (run.found.length === 0) return { id: run.check.id, status: 'ok' };
  return { id: run.check.id, status: run.check.severity === 'blocking' ? 'fail' : 'info', detail: run.found.join('；') };
}

export function findings(run: CheckRun): EnvelopeDiagnostic[] {
  return run.found.map((message) => ({ code: run.check.code, severity: run.check.severity, message, remedy: remedyOf(run.check.id) }));
}

export function remedyOf(id: string) {
  switch (id) {
    case 'projection':
      return { command: 'xforge sync', text: '重新投影；手改的内容先挪回 xforge/scaffold/' };
    case 'scaffold':
      return { command: 'xforge update', text: '用新版载荷补齐骨架，或按诊断里的路径改清单' };
    case 'version':
      return { command: 'xforge update', text: '用新版载荷补齐骨架' };
    case 'residue':
      return { command: 'xforge update --status', text: '在途升级先收尾；孤儿文件对照上面那条删' };
    case 'host':
      return { text: '装上那个宿主，或者手改清单的 platforms' };
    case 'capability':
      return { text: '把 xforge-enforce 装到宿主进程也看得到的 PATH 上（npm i -g @xforge/cli）；诊断点名的那份宿主共享配置文件读不懂的，先修好它再 sync' };
    default:
      return { text: '把 CLI 装到宿主进程也看得到的 PATH 上（npm i -g @xforge/cli）' };
  }
}

/** 体检的上下文：一次算清，几项检查看的是同一份（`repair` 用的也是它，不然两处迟早各说各话）。 */
export async function context(root: string, only: readonly Platform[], env: NodeJS.ProcessEnv): Promise<Ctx> {
  const paths = governancePaths(root);
  const manifest = await readYaml<Manifest>(paths.manifest, 'manifest');
  const platforms = only.length ? only : manifest.platforms;
  const projectionCtx = await projectionContext(root, paths, manifest);
  return { root, paths, manifest, platforms, env, payload: payloadDir(), files: await projections(projectionCtx, platforms), hook: projectionCtx.hook };
}

/**
 * 指路只给真能修的那一步：投影与残留归 `sync`，骨架与版本归 `update`。
 * 宿主不在、钩子跑不起来是这台机器的事，没有命令可给 —— 那就什么都不指，别拿 `inspect` 凑数。
 */
export function nextFor(results: readonly CheckResult[]) {
  const bad = (id: string): boolean => results.some((r) => r.id === id && r.status !== 'ok');
  const out: Array<{ command: string; why: string }> = [];
  if (bad('projection') || bad('residue')) out.push({ command: 'xforge sync', why: '把投影重新对齐' });
  if (bad('scaffold') || bad('version')) out.push({ command: 'xforge update', why: '用新版载荷补齐骨架' });
  return out;
}

/** `only` 已经过调用方校验（命令面负责把打错的宿主名变成用法错误）；空表示清单里的那些。 */
export async function doctor(root: string, only: readonly Platform[], env: NodeJS.ProcessEnv): Promise<Outcome<DoctorResult>> {
  const runs = await runChecks(await context(root, only, env));
  const results = runs.map(resultOf);
  return {
    result: { results, problems: results.filter((r) => r.status === 'fail').length },
    diagnostics: runs.flatMap(findings),
    changed: [],
    next: nextFor(results),
  };
}
