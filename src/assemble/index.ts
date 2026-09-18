// design: cli §5 — 装配：init 从零建治理目录树（重入幂等），sync 把脚手架投影到宿主原生位置。
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import fg from 'fast-glob';
import type { Parsed } from '../cli/args.js';
import { flagBool, flagList, flagString } from '../cli/args.js';
import type { Io, Outcome } from '../cli/envelope.js';
import { Aborted, ask, type Choice, type Question } from '../cli/prompt.js';
import { CliError, UsageError } from '../cli/errors.js';
import { ModelError } from '../model/errors.js';
import { exists, readText, Transaction } from '../fs/transaction.js';
import { sha256 } from '../model/digest.js';
import { detect, knownProviderIds, providerFor, providers, type HostFile } from '../providers/index.js';
import { runDoctor } from './doctor.js';
import { runRepair } from './repair.js';
import { footprintOf, ledgerUnreadable, projectedFiles, pruneEmptyDirs, readLedger, rel } from './hosts.js';
import { cliVersion, payloadDir } from '../meta/index.js';
import { findProjectRoot, governancePaths, type GovernancePaths } from '../model/paths.js';
import type { EnvelopeDiagnostic, HostsLedger, Language, Manifest, Platform } from '../model/types.js';
import { readYaml, toYaml } from '../model/yaml.js';
import { upgradeFinish, upgradeRollback, upgradeStage, upgradeStatusReport, type UpgradeContext } from './upgrade.js';

export const ASSEMBLE_VERBS = ['init', 'sync', 'update', 'upgrade', 'doctor', 'repair', 'remove'] as const;
export type AssembleVerb = (typeof ASSEMBLE_VERBS)[number];

export async function runAssemble(verb: AssembleVerb, parsed: Parsed, cwd: string, env: NodeJS.ProcessEnv, io?: Io): Promise<Outcome> {
  switch (verb) {
    case 'init':
      return init(cwd, parsed, env, io);
    case 'sync': {
      const root = await findProjectRoot(cwd, env);
      if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { command: 'xforge init', text: '先初始化' });
      const platforms = checkedPlatforms(parsed);
      return sync(root, platforms.length ? platforms : undefined);
    }
    case 'doctor': {
      const root = await findProjectRoot(cwd, env);
      if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { command: 'xforge init', text: '先初始化' });
      const paths = governancePaths(root);
      const platforms = checkedPlatforms(parsed);
      return runDoctor(root, paths, await loadManifest(paths), env, platforms.length ? platforms : undefined);
    }
    case 'repair': {
      const root = await findProjectRoot(cwd, env);
      if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { command: 'xforge init', text: '先初始化' });
      const paths = governancePaths(root);
      return runRepair(root, paths, await loadManifest(paths), env, {
        only: flagList(parsed, 'only'),
        dryRun: flagBool(parsed, 'dry-run'),
        reproject: async (ids) => {
          const outcome = await sync(root, ids);
          return { changed: outcome.changed ?? [], diagnostics: outcome.diagnostics ?? [] };
        },
      });
    }
    case 'update':
    case 'upgrade': {
      const root = await findProjectRoot(cwd, env);
      if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { command: 'xforge init', text: '先初始化' });
      const paths = governancePaths(root);
      const manifest = await loadManifest(paths);
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
      throw new UsageError('用法: xforge init | update [--status|--finish|--rollback] | sync | doctor | repair | remove --confirm <项目目录名>');
  }
}

/** 清单读不出是损坏（退出码 3），不是「不能」。 */
async function loadManifest(paths: GovernancePaths): Promise<Manifest> {
  return readYaml<Manifest>(paths.manifest, 'manifest').catch((error: unknown) => {
    if (error instanceof ModelError) throw new CliError(error.code, error.message, 3, { text: '按诊断里的路径与字段改清单' }, error.details);
    throw error;
  });
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

/** 拆除：整个治理目录与台账里记着的全部宿主投影一起删；破坏性，必须点名确认（命令行设计 D10、§5.6）。 */
async function remove(cwd: string, confirm: string | undefined, env: NodeJS.ProcessEnv): Promise<Outcome<{ removed: string[] }>> {
  const root = await findProjectRoot(cwd, env);
  if (!root) throw new CliError('XF-STATE-002', '找不到治理根', 3, { text: '这里没有 XForge 可拆' });
  const name = basename(root);
  if (confirm !== name) {
    throw new CliError('XF-ASSEMBLE-004', `拆除会删掉 xforge/ 与全部宿主投影，需要 --confirm ${name}`, 1, { command: `xforge remove --confirm ${name}`, text: '点名确认后才执行；这是不可逆的' });
  }
  const paths = governancePaths(root);
  const { ledger } = await readLedger(paths);
  const removed: string[] = [];

  // 台账有就照台账拆，没有（或读不出）就按每个 provider 的已知布局拆：拆除不能因为丢了一份派生文件就漏掉东西。
  for (const provider of providers()) {
    for (const record of await footprintOf(root, ledger, provider)) {
      const abs = join(root, record.path);
      if (record.kind === 'owned') {
        if (!existsSync(abs)) continue;
        rmSync(abs, { force: true });
        removed.push(record.path);
        continue;
      }
      const detached = await provider.detach(root, abs);
      if (detached && detached.content !== (await readText(abs))) {
        writeFileSync(abs, detached.content);
        removed.push(`${record.path}#XFORGE`);
      }
    }
  }

  if (existsSync(paths.root)) {
    rmSync(paths.root, { recursive: true, force: true });
    removed.push(relative(root, paths.root));
  }
  await pruneEmptyDirs(root, removed);
  return { result: { removed }, changed: removed, next: [] };
}

const CONSTITUTION_TEMPLATE = `# 章程

<!-- xforge:constitution -->
> 每个二级标题是一条章程的 id。改标题是治理变更：此前所有引用该条的台账将对不上。改正文不是。

## 不做无测试的行为变更

任何改变对外行为的改动，都要有能证明它的测试；没有测试的行为变更不进主线。
`;

async function init(cwd: string, parsed: Parsed, env: NodeJS.ProcessEnv, io?: Io): Promise<Outcome<{ created: string[]; synced: string[] }>> {
  const root = (await findProjectRoot(cwd, env)) ?? cwd;
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
    let platforms = checkedPlatforms(parsed);
    let language = flagString(parsed, 'language') as Language | undefined;
    const flow = flagString(parsed, 'flow') ?? 'solid';
    // 流程名先校验再提问：问完两道题才说「没有这个流程」是白问一遍。
    if (!flows.includes(flow)) throw new UsageError(`没有流程 ${flow}；可选：${flows.join('、')}`);
    if (interactive(parsed, io, env)) {
      const answers = await askAtInit(env, io!, { platforms, language });
      platforms = answers.platforms;
      language = answers.language;
    }
    const manifest: Manifest = {
      version: 1,
      scaffold: { version: cliVersion() },
      governance: { spec: false, interface: false },
      flow: { default: flow },
      modules: [],
      platforms: platforms.length ? platforms : ['claude'],
      language: language ?? 'zh-CN',
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

/**
 * 有没有人坐在终端前（D15）。判的是 **stdin 与 stderr** —— 画面走 stderr，
 * 判 stdout 会让 `xforge init > out.json` 在真人的终端里悄悄变成「不问」。
 * `--no-input` 与 `CI` 各是一条明确的「别问」。不满足就走原来的路：
 * live harness、integration 测试与 Agent 的调用全是非交互的。
 */
function interactive(parsed: Parsed, io: Io | undefined, env: NodeJS.ProcessEnv): boolean {
  if (!io?.stdin?.isTTY || !io.stderr.isTTY) return false;
  if (flagBool(parsed, 'no-input')) return false;
  return !env['CI'];
}

/** 工具那一问的选项：探测到的可选，没探测到的灰显。一个都没探测到就全部放开，否则这一问无解。 */
export function toolChoices(env: NodeJS.ProcessEnv): Choice[] {
  const tools: Choice[] = providers().map((p) => {
    const found = detect(p, env);
    const choice: Choice = { value: p.id, label: p.displayName };
    choice.note = found.installed ? `detected${found.version ? ` ${found.version}` : ''}` : 'not detected';
    if (!found.installed) choice.disabled = true;
    return choice;
  });
  if (tools.every((t) => t.disabled)) {
    for (const t of tools) {
      delete t.disabled;
      t.note = 'not detected here — files are written anyway';
    }
  }
  return tools;
}

/** 装机那两问：工具（多选）与语言（单选）。文案是英文，画面走 stderr。 */
async function askAtInit(env: NodeJS.ProcessEnv, io: Io, given: { platforms: Platform[]; language: Language | undefined }): Promise<{ platforms: Platform[]; language?: Language }> {
  // 命令行上已经说出来的不再问：提问是替没说的那一半服务的，问一遍说过的话是噪音。
  const questions: Question[] = [];
  if (!given.platforms.length) questions.push({ key: 'platform', prompt: 'Which AI coding tools should XForge project into?', choices: toolChoices(env), multi: true });
  if (given.language === undefined) {
    questions.push({
      key: 'language',
      prompt: 'Which language should the projected Skills use?',
      choices: [
        { value: 'zh-CN', label: 'Chinese (zh-CN)', note: 'the language the Skills are authored in' },
        { value: 'en', label: 'English', note: 'translated from the Chinese source' },
      ],
      multi: false,
    });
  }
  if (!questions.length) return { platforms: given.platforms, ...(given.language ? { language: given.language } : {}) };
  const view = { color: !env['NO_COLOR'], columns: Math.max(20, io.stderr.columns ?? 80) };
  try {
    const answers = await ask(questions, { input: io.stdin!, output: io.stderr, view });
    return {
      platforms: given.platforms.length ? given.platforms : (answers['platform'] ?? []),
      ...(given.language ? { language: given.language } : answers['language']?.[0] ? { language: answers['language'][0] as Language } : {}),
    };
  } catch (error) {
    if (error instanceof Aborted) throw new UsageError('init cancelled');
    throw error;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
  } catch {
    return [];
  }
}

export async function sync(root: string, only: readonly Platform[] | undefined): Promise<Outcome<{ files: string[]; removed: string[] }>> {
  const paths = governancePaths(root);
  const manifest = await readYaml<Manifest>(paths.manifest, 'manifest');
  const { ledger, unreadable } = await readLedger(paths);
  const declared = only ?? manifest.platforms;
  // 台账里有、清单里已经没有的 provider：全量 sync 时也在范围内 —— 它投出去的文件要回收。
  // 台账读不出时按认得的 provider 全扫一遍：兜底认孤儿，比丢下它们不管强。
  const stale = only ? [] : (unreadable ? knownProviderIds() : ledger.providers.map((p) => p.id)).filter((id) => !manifest.platforms.includes(id));
  const scope = [...new Set([...declared, ...stale])];

  const diagnostics: EnvelopeDiagnostic[] = [];
  if (unreadable) diagnostics.push(ledgerUnreadable());
  const projected = new Map<string, HostFile[]>();
  for (const p of await projectedFiles(root, paths, manifest, declared)) {
    if (p.hookMissing) {
      diagnostics.push({ code: 'XF-ASSEMBLE-008', severity: 'warning', message: `${p.provider.id} 能执法，但没有 scaffold/hooks/enforce.yaml 可投：这一次没有投钩子`, remedy: { command: 'xforge doctor', text: '把钩子声明放回脚手架再 sync' } });
    }
    if (p.hookBlocked) {
      diagnostics.push({ code: 'XF-ASSEMBLE-013', severity: 'warning', message: `${p.hookBlocked} 解析不成 JSON 对象：那是别人写的文件，一个字节都没动，${p.provider.id} 的执法钩子这一次没装进去`, remedy: { command: 'xforge doctor', text: '人把它改回合法的 JSON 再 sync' } });
    }
    projected.set(p.provider.id, p.files);
  }

  const tx = new Transaction(root, paths.txDir);
  const files: HostFile[] = [...projected.values()].flat();
  for (const f of files) {
    const current = await readText(f.path);
    if (current !== f.content) tx.write(f.path, f.content);
  }

  // 孤儿回收：台账里有、这一次不该再有的。owned 删掉；shared 只摘掉我们那块。
  const removed: string[] = [];
  for (const id of scope) {
    const provider = providerFor(id);
    if (!provider) continue;
    const before = await footprintOf(root, ledger, provider);
    const keep = new Set((projected.get(id) ?? []).map((f) => rel(root, f.path)));
    for (const record of before) {
      if (keep.has(record.path)) continue;
      const abs = join(root, record.path);
      if (record.kind === 'owned') {
        if (await exists(abs)) {
          tx.removeFile(abs);
          removed.push(record.path);
        }
        continue;
      }
      const detached = await providerFor(id)?.detach(root, abs);
      if (detached && (await readText(abs)) !== detached.content) {
        tx.write(abs, detached.content);
        removed.push(`${record.path}#XFORGE`);
      } else if (!detached && (await exists(abs))) {
        diagnostics.push({ code: 'XF-ASSEMBLE-007', severity: 'warning', message: `${record.path} 是 ${id} 留下的孤儿，但它是共用文件，控制面不动它`, remedy: { text: '人把里面 XFORGE 的那块摘掉' } });
      }
    }
  }

  const next: HostsLedger = {
    version: 1,
    providers: [
      ...ledger.providers.filter((p) => !scope.includes(p.id)),
      ...[...projected.entries()].filter(([, fs]) => fs.length).map(([id, fs]) => ({ id, files: fs.map((f) => ({ path: rel(root, f.path), kind: (f.shared ? 'shared' : 'owned') as 'owned' | 'shared', checksum: `sha256:${sha256(f.content)}` })).sort((a, b) => a.path.localeCompare(b.path)) })),
    ].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const ledgerText = toYaml(next);
  if ((await readText(paths.hostsLedger)) !== ledgerText) tx.write(paths.hostsLedger, ledgerText);

  const changed = await tx.commit();
  await pruneEmptyDirs(root, removed);
  return { result: { files: files.map((f) => rel(root, f.path)), removed }, changed, diagnostics, next: [] };
}

/** 命令行上给的 provider 名字当场校验：打错名字是用法错（退出码 2），不是清单损坏。 */
function checkedPlatforms(parsed: Parsed): Platform[] {
  const given = flagList(parsed, 'platform');
  for (const id of given) if (!providerFor(id)) throw new UsageError(`没有 provider ${id}；可选：${knownProviderIds().join('、')}`);
  return given;
}

