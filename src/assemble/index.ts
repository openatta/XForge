// design: cli §5 — 装配：init 从零建治理目录树（重入幂等），sync 把脚手架投影到宿主原生位置。
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join, relative } from 'node:path';
import fg from 'fast-glob';
import type { Parsed } from '../cli/args.js';
import { flagBool, flagList, flagString } from '../cli/args.js';
import type { Outcome } from '../cli/envelope.js';
import { CliError, UsageError } from '../cli/errors.js';
import { ModelError } from '../model/errors.js';
import { exists, readText, Transaction } from '../fs/transaction.js';
import { isEnforceCommand } from '../providers/claude.js';
import { BLOCK_BEGIN, hookCommandFor, knownProviderIds, providerFor, stripMarkerBlock, type HostFile, type SkillSource } from '../providers/index.js';
import { cliVersion } from '../meta/index.js';
import { findProjectRoot, governancePaths, type GovernancePaths } from '../model/paths.js';
import type { EnvelopeDiagnostic, Executor, Language, Manifest, Platform } from '../model/types.js';
import { readYaml, toYaml } from '../model/yaml.js';
import { upgradeFinish, upgradeRollback, upgradeStage, upgradeStatusReport, type UpgradeContext } from './upgrade.js';

export const ASSEMBLE_VERBS = ['init', 'sync', 'update', 'upgrade', 'remove'] as const;
export type AssembleVerb = (typeof ASSEMBLE_VERBS)[number];

export function payloadDir(): string {
  return fileURLToPath(new URL('../../scaffold/', import.meta.url));
}

export async function runAssemble(verb: AssembleVerb, parsed: Parsed, cwd: string, env: NodeJS.ProcessEnv): Promise<Outcome> {
  switch (verb) {
    case 'init':
      return init(cwd, parsed, env);
    case 'sync': {
      const root = await findProjectRoot(cwd, env);
      if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { command: 'xforge init', text: '先初始化' });
      const platforms = checkedPlatforms(parsed);
      return sync(root, platforms.length ? platforms : undefined);
    }
    case 'update':
    case 'upgrade': {
      const root = await findProjectRoot(cwd, env);
      if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { command: 'xforge init', text: '先初始化' });
      const paths = governancePaths(root);
      const manifest = await readYaml<Manifest>(paths.manifest, 'manifest').catch((error: unknown) => {
        if (error instanceof ModelError) throw new CliError(error.code, error.message, 3, { text: '按诊断里的路径与字段改清单' }, error.details);
        throw error;
      });
      const fixedNow = env['XFORGE_NOW'];
      const ctx: UpgradeContext = { root, paths, manifest, env, now: () => fixedNow ?? new Date().toISOString(), payloadDir: flagString(parsed, 'payload') ?? payloadDir(), targetVersion: flagString(parsed, 'to') ?? cliVersion() };
      const outcome = flagBool(parsed, 'status')
        ? await upgradeStatusReport(ctx)
        : flagBool(parsed, 'finish')
          ? await finishAndSync(ctx, root)
          : flagBool(parsed, 'rollback')
            ? await upgradeRollback(ctx)
            : await upgradeStage(ctx);
      return verb === 'upgrade' ? deprecated(outcome) : outcome;
    }
    case 'remove':
      return remove(cwd, flagString(parsed, 'confirm'), env);
    default:
      throw new UsageError('用法: xforge init | update [--status|--finish|--rollback] | sync | remove --confirm <项目目录名>');
  }
}

/** 旧名 `upgrade`：行为完全相同，只在信封里多一条 warning（命令行设计 D12）。 */
function deprecated(outcome: Outcome): Outcome {
  const diagnostics = [...(outcome.diagnostics ?? []), { code: 'XF-ASSEMBLE-011', severity: 'warning' as const, message: 'upgrade 是旧名，用 update', remedy: { command: 'xforge update', text: '把脚本与文档里的 xforge upgrade 换掉' } }];
  return { ...outcome, diagnostics };
}

/** `--finish` 收尾自动投一次：脚手架换了新版，宿主上还是旧的 Skill 没有意义（D12）。 */
async function finishAndSync(ctx: UpgradeContext, root: string): Promise<Outcome> {
  const finished = await upgradeFinish(ctx);
  const synced = await sync(root, undefined);
  return {
    ...finished,
    changed: [...(finished.changed ?? []), ...(synced.changed ?? [])],
    diagnostics: [...(finished.diagnostics ?? []), ...(synced.diagnostics ?? [])],
    next: [{ command: 'xforge state --orient', why: '新脚手架已投到宿主' }],
  };
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
  for (const host of ['.claude', '.codex']) {
    const skills = join(root, host, 'skills');
    if (existsSync(skills)) for (const d of readdirSync(skills)) if (d === 'xforge' || d.startsWith('xforge-')) dropDir(join(skills, d));
    dropDir(join(root, host, 'agents', 'xforge-executor.md'));
  }
  const settingsPath = join(root, '.claude', 'settings.json');
  const settingsText = await readText(settingsPath);
  if (settingsText) {
    try {
      const settings = JSON.parse(settingsText) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
      const pre = settings.hooks?.['PreToolUse'];
      if (pre) {
        const kept = pre.filter((e) => !(e.hooks ?? []).some((h) => isEnforceCommand(h.command)));
        if (kept.length !== pre.length) {
          settings.hooks!['PreToolUse'] = kept;
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
          removed.push(relative(root, settingsPath) + '#hooks.PreToolUse');
        }
      }
    } catch {
      // 不是我们写的 JSON，不动。
    }
  }
  const agentsPath = join(root, 'AGENTS.md');
  const agents = await readText(agentsPath);
  if (agents && agents.includes(BLOCK_BEGIN)) {
    writeFileSync(agentsPath, stripMarkerBlock(agents));
    removed.push('AGENTS.md#XFORGE');
  }
  return { result: { removed }, changed: removed, next: [] };
}

const CONSTITUTION_TEMPLATE = `# 章程

<!-- xforge:constitution -->
> 每个二级标题是一条章程的 id。改标题是治理变更：此前所有引用该条的台账将对不上。改正文不是。

## 不做无测试的行为变更

任何改变对外行为的改动，都要有能证明它的测试；没有测试的行为变更不进主线。
`;

async function init(cwd: string, parsed: Parsed, _env: NodeJS.ProcessEnv): Promise<Outcome<{ created: string[]; synced: string[] }>> {
  const root = (await findProjectRoot(cwd, _env)) ?? cwd;
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
    const platforms = checkedPlatforms(parsed);
    const language = (flagString(parsed, 'language') ?? 'zh-CN') as Language;
    const flow = flagString(parsed, 'flow') ?? 'solid';
    if (!flows.includes(flow)) throw new UsageError(`没有流程 ${flow}；可选：${flows.join('、')}`);
    const manifest: Manifest = {
      version: 1,
      scaffold: { version: cliVersion() },
      governance: { spec: false, interface: false },
      flow: { default: flow },
      modules: [],
      platforms: platforms.length ? platforms : ['claude'],
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

export async function sync(root: string, only: readonly Platform[] | undefined): Promise<Outcome<{ files: string[] }>> {
  const paths = governancePaths(root);
  const manifest = await readYaml<Manifest>(paths.manifest, 'manifest');
  const platforms = only ?? manifest.platforms;
  const skills = await loadSkills(paths, manifest.language);
  const executor = await loadExecutor(paths, manifest.language);
  const files: HostFile[] = [];
  const diagnostics: EnvelopeDiagnostic[] = [];
  for (const id of platforms) {
    const provider = providerFor(id);
    if (!provider) {
      throw new CliError('XF-ASSEMBLE-005', `清单里的 ${id} 不是这个版本认得的 provider`, 1, { command: 'xforge doctor', text: `认得的是：${knownProviderIds().join('、')}` });
    }
    const hookCommand = await hookCommandFor(paths, provider);
    if (provider.capabilities.enforcement && hookCommand === null) {
      diagnostics.push({ code: 'XF-ASSEMBLE-008', severity: 'warning', message: `${provider.id} 能执法，但没有 scaffold/hooks/enforce.yaml 可投：这一次没有投钩子`, remedy: { command: 'xforge doctor', text: '把钩子声明放回脚手架再 sync' } });
    }
    files.push(...(await provider.project({ root, skills, executor, language: manifest.language, hookCommand })));
  }
  const tx = new Transaction(root, paths.txDir);
  for (const f of files) {
    const current = await readText(f.path);
    if (current !== f.content) tx.write(f.path, f.content);
  }
  const changed = await tx.commit();
  return { result: { files: files.map((f) => relative(root, f.path)) }, changed, diagnostics, next: [] };
}

/** 命令行上给的 provider 名字当场校验：打错名字是用法错（退出码 2），不是清单损坏。 */
function checkedPlatforms(parsed: Parsed): Platform[] {
  const given = flagList(parsed, 'platform');
  for (const id of given) if (!providerFor(id)) throw new UsageError(`没有 provider ${id}；可选：${knownProviderIds().join('、')}`);
  return given;
}

async function loadSkills(paths: GovernancePaths, language: Language): Promise<SkillSource[]> {
  const dir = join(paths.scaffold, 'skills');
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  const out: SkillSource[] = [];
  for (const name of names) {
    const text = await readText(paths.skill(name, language));
    if (text !== null) out.push({ name, text });
  }
  return out;
}

async function loadExecutor(paths: GovernancePaths, language: Language): Promise<{ def: Executor; prompt: string } | null> {
  const defPath = paths.executor('xforge-executor');
  if (!(await exists(defPath))) return null;
  const def = await readYaml<Executor>(defPath, 'executor');
  const promptRel = language === 'zh-CN' ? def.prompt_file : def.prompt_file.replace(/_cn\.md$/, '.md');
  const promptPath = join(join(defPath, '..'), promptRel);
  const prompt = (await readText(promptPath)) ?? (await readText(join(join(defPath, '..'), def.prompt_file))) ?? '';
  await stat(defPath);
  return { def, prompt };
}
