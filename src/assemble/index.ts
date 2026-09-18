// design: cli §5 — 装配：init 从零建治理目录树（重入幂等），sync 把脚手架投影到宿主原生位置。
import { existsSync, rmSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import fg from 'fast-glob';
import type { Parsed } from '../cli/args.js';
import { flagBool, flagList, flagString } from '../cli/args.js';
import type { Io, Outcome } from '../cli/envelope.js';
import type { EnvelopeDiagnostic } from '../model/types.js';
import { CliError, UsageError } from '../cli/errors.js';
import { ModelError } from '../model/errors.js';
import { exists, readText, Transaction } from '../fs/transaction.js';
import { isPlatform, PLATFORMS, provider } from '../hosts/index.js';
import { cliVersion, payloadDir } from '../meta/index.js';
import { findProjectRoot, governancePaths } from '../model/paths.js';
import type { Language, Manifest, Platform } from '../model/types.js';
import { readYaml, toYaml } from '../model/yaml.js';
import { doctor } from './doctor.js';
import { askInit } from './interactive.js';
import { repair } from './repair.js';
import { projections, projectionContext } from './projection.js';
import { upgradeFinish, upgradeRollback, upgradeStage, upgradeStatusReport, type UpgradeContext } from './upgrade.js';

export const ASSEMBLE_VERBS = ['init', 'sync', 'update', 'doctor', 'repair', 'remove'] as const;
export type AssembleVerb = (typeof ASSEMBLE_VERBS)[number];

/** 旧名仍可用：1.0.1 已经发出去了，改名不能把用户绊倒。用旧名会多一条 deprecation 诊断。 */
export const VERB_ALIASES: Readonly<Record<string, AssembleVerb>> = { upgrade: 'update' };

export function resolveAssembleVerb(verb: string): AssembleVerb | null {
  if ((ASSEMBLE_VERBS as readonly string[]).includes(verb)) return verb as AssembleVerb;
  return VERB_ALIASES[verb] ?? null;
}

/** 用了旧名时附在信封末尾的一条诊断（不挡路，只是提醒）。 */
export function deprecation(used: string, actual: AssembleVerb): EnvelopeDiagnostic {
  return { code: 'XF-ASSEMBLE-005', severity: 'warning', message: `${used} 已更名为 ${actual}`, remedy: { command: `xforge ${actual}`, text: '旧名仍可用，但会一直是旧名' } };
}

export async function runAssemble(verb: AssembleVerb, parsed: Parsed, cwd: string, io: Io): Promise<Outcome> {
  const env = io.env;
  switch (verb) {
    case 'init':
      return init(cwd, parsed, io);
    case 'sync': {
      const root = await findProjectRoot(cwd, env);
      if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { command: 'xforge init', text: '先初始化' });
      const platforms = flagList(parsed, 'platform') as Platform[];
      return sync(root, platforms.length ? platforms : undefined);
    }
    case 'update': {
      const root = await findProjectRoot(cwd, env);
      if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { command: 'xforge init', text: '先初始化' });
      const paths = governancePaths(root);
      const manifest = await readYaml<Manifest>(paths.manifest, 'manifest').catch((error: unknown) => {
        if (error instanceof ModelError) throw new CliError(error.code, error.message, 3, { text: '按诊断里的路径与字段改清单' }, error.details);
        throw error;
      });
      const fixedNow = env['XFORGE_NOW'];
      const ctx: UpgradeContext = { root, paths, manifest, env, now: () => fixedNow ?? new Date().toISOString(), payloadDir: flagString(parsed, 'payload') ?? payloadDir(), targetVersion: flagString(parsed, 'to') ?? cliVersion() };
      if (flagBool(parsed, 'status')) return upgradeStatusReport(ctx);
      if (flagBool(parsed, 'finish')) return upgradeFinish(ctx);
      if (flagBool(parsed, 'rollback')) return upgradeRollback(ctx);
      return upgradeStage(ctx);
    }
    case 'doctor': {
      const root = await findProjectRoot(cwd, env);
      if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { command: 'xforge init', text: '先初始化' });
      const platforms = flagList(parsed, 'platform') as Platform[];
      checkPlatforms(platforms);
      return doctor(root, platforms, env);
    }
    case 'repair': {
      const root = await findProjectRoot(cwd, env);
      if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { command: 'xforge init', text: '先初始化' });
      const platforms = flagList(parsed, 'platform') as Platform[];
      checkPlatforms(platforms);
      return repair(root, platforms, env);
    }
    case 'remove':
      return remove(cwd, flagString(parsed, 'confirm'), env);
    default:
      throw new UsageError('用法: xforge init | sync | update [--status|--finish|--rollback] | doctor | repair | remove --confirm <项目目录名>');
  }
}

/** 拆除：整个治理目录与所有宿主投影一起删；破坏性，必须点名确认（命令行设计 D10）。 */
async function remove(cwd: string, confirm: string | undefined, env: NodeJS.ProcessEnv): Promise<Outcome<{ removed: string[] }>> {
  const root = await findProjectRoot(cwd, env);
  if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { text: '这里没有 XForge 可拆' });
  const name = basename(root);
  if (confirm !== name) {
    throw new CliError('XF-ASSEMBLE-004', `拆除会删掉 xforge/ 与全部宿主投影，需要 --confirm ${name}`, 1, { command: `xforge remove --confirm ${name}`, text: '点名确认后才执行；这是不可逆的' });
  }
  const paths = governancePaths(root);
  const removed: string[] = [];
  const dropDir = (p: string): void => {
    if (!existsSync(p)) return;
    rmSync(p, { recursive: true, force: true });
    removed.push(relative(root, p));
  };
  dropDir(paths.root);
  // 宿主投影：每个宿主自己说它占了哪些路径、共享文件里留了什么痕迹。
  for (const id of PLATFORMS) {
    for (const owned of await provider(id).ownership(root)) dropDir(owned);
    removed.push(...(await provider(id).detach(root)));
  }
  return { result: { removed }, changed: removed, next: [] };
}

const CONSTITUTION_TEMPLATE = `# 章程

<!-- xforge:constitution -->
> 每个二级标题是一条章程的 id。改标题是治理变更：此前所有引用该条的台账将对不上。改正文不是。

## 不做无测试的行为变更

任何改变对外行为的改动，都要有能证明它的测试；没有测试的行为变更不进主线。
`;

async function init(cwd: string, parsed: Parsed, io: Io): Promise<Outcome<{ created: string[]; synced: string[] }>> {
  const root = (await findProjectRoot(cwd, io.env)) ?? cwd;
  const paths = governancePaths(root);
  const payload = payloadDir();
  const created: string[] = [];
  // 机制级：复制载荷，已有的不覆盖。
  for (const rel of (await fg('**/*', { cwd: payload, onlyFiles: true, dot: false })).sort()) {
    const target = join(paths.scaffold, rel);
    if (await exists(target)) continue;
    await mkdir(join(target, '..'), { recursive: true });
    await copyFile(join(payload, rel), target);
    created.push(relative(root, target));
  }
  const tx = new Transaction(root, paths.txDir);
  if (!(await exists(paths.manifest))) {
    const flows = (await listNames(join(payload, 'flows'))).map((f) => f.replace(/\.yaml$/, ''));
    const gates = (await listNames(join(payload, 'gates'))).map((f) => f.replace(/\.yaml$/, ''));
    const policies = (await listNames(join(payload, 'policies'))).map((f) => f.replace(/\.yaml$/, ''));
    const { platforms, language } = await answers(io, parsed);
    const flow = flagString(parsed, 'flow') ?? 'solid';
    if (!flows.includes(flow)) throw new UsageError(`没有流程 ${flow}；可选：${flows.join('、')}`);
    const manifest: Manifest = {
      version: 1,
      scaffold: { version: cliVersion() },
      governance: { spec: false, interface: false },
      flow: { default: flow },
      modules: [],
      platforms,
      language,
      selected: { flows, gates, policies },
    };
    tx.write(paths.manifest, toYaml(manifest));
  }
  if (!(await exists(paths.constitution))) tx.write(paths.constitution, CONSTITUTION_TEMPLATE);
  if (!(await exists(paths.specsIndex))) tx.write(paths.specsIndex, 'domains: []\n');
  if (!(await exists(paths.interfacesIndex))) tx.write(paths.interfacesIndex, 'domains: []\n');
  await mkdir(paths.changes, { recursive: true });
  created.push(...(await tx.commit()));
  const synced = await sync(root, undefined);
  return { result: { created, synced: synced.changed ?? [] }, changed: [...created, ...(synced.changed ?? [])], next: [{ command: 'xforge state --orient', why: '看这个项目的定向' }] };
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
  } catch {
    return [];
  }
}

/** 未知宿主是用法错误，不是静默跳过 —— 打错一个字母就少投影一套，没人会发现。 */
function checkPlatforms(platforms: readonly Platform[]): void {
  for (const p of platforms) if (!isPlatform(p)) throw new UsageError(`没有宿主 ${p}；可选：${PLATFORMS.join('、')}`);
}

function checkLanguage(language: string): asserts language is Language {
  if (language !== 'zh-CN' && language !== 'en') throw new UsageError(`没有语言 ${language}；可选：zh-CN、en`);
}

/**
 * 清单里那两个只能由人定的值：装到哪些宿主、Skill 用哪种语言。
 * 有人坐在终端前就问，没有就用 flag 或文档默认值 —— 分岔只在「值从哪来」，见 cli §5.4。
 */
async function answers(io: Io, parsed: Parsed): Promise<{ platforms: Platform[]; language: Language }> {
  const flags = flagList(parsed, 'platform') as Platform[];
  checkPlatforms(flags);
  const language = flagString(parsed, 'language');
  if (language !== undefined) checkLanguage(language);
  if (!io.interactive) return { platforms: flags.length ? flags : ['claude'], language: language ?? 'zh-CN' };
  return askInit(io, { platforms: flags, ...(language !== undefined ? { language } : {}) });
}

export async function sync(root: string, only: readonly Platform[] | undefined): Promise<Outcome<{ files: string[] }>> {
  const paths = governancePaths(root);
  const manifest = await readYaml<Manifest>(paths.manifest, 'manifest');
  const platforms = only ?? manifest.platforms;
  checkPlatforms(platforms);
  // 投影怎么算只有一处实现（`projection.ts`）：sync 拿它写盘，doctor 拿它比对。
  const files = await projections(await projectionContext(root, paths, manifest), platforms);
  const tx = new Transaction(root, paths.txDir);
  for (const f of files) {
    const current = await readText(f.path);
    if (current !== f.content) tx.write(f.path, f.content);
  }
  const changed = await tx.commit();
  return { result: { files: files.map((f) => relative(root, f.path)) }, changed, next: [] };
}
