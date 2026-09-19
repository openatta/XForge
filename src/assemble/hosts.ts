// design: cli §5 — 宿主投影的计算与台账：sync 投它、doctor 验它、repair 修它，三个命令同一份算法。
import { readdir, stat } from 'node:fs/promises';
import { readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CliError } from '../cli/errors.js';
import { exists, readText } from '../fs/transaction.js';
import type { GovernancePaths } from '../model/paths.js';
import type { EnvelopeDiagnostic, Executor, HostsLedger, Language, Manifest } from '../model/types.js';
import { readYaml } from '../model/yaml.js';
import { canEnforce, hookCommandFor, knownProviderIds, providerFor, type HostFile, type Provider, type SkillSource } from '../providers/index.js';

/** 项目根相对的 posix 路径：台账里的键。 */
export function rel(root: string, path: string): string {
  return relative(root, path).split('\\').join('/');
}

export function providerOrThrow(id: string): Provider {
  const provider = providerFor(id);
  if (provider) return provider;
  throw new CliError('XF-ASSEMBLE-005', `清单里的 ${id} 不是这个版本认得的 provider`, 1, { command: 'xforge doctor', text: `认得的是：${knownProviderIds().join('、')}` });
}

export interface LedgerRead {
  ledger: HostsLedger;
  /** 台账在、但读不出来：调用方按空台账继续，并把 `XF-ASSEMBLE-017` 报出去。 */
  unreadable: boolean;
}

/**
 * 读台账。**它是派生物，不是真相**：读不出来不该让 `sync`/`doctor` 整个倒下 ——
 * 重投一次台账就回来了。所以这里不抛，只如实说「这一份读不出来」。
 */
export async function readLedger(paths: GovernancePaths): Promise<LedgerRead> {
  const empty: HostsLedger = { version: 1, providers: [] };
  if (!(await exists(paths.hostsLedger))) return { ledger: empty, unreadable: false };
  try {
    return { ledger: await readYaml<HostsLedger>(paths.hostsLedger, 'hosts'), unreadable: false };
  } catch {
    return { ledger: empty, unreadable: true };
  }
}

export const ledgerUnreadable = (): EnvelopeDiagnostic => ({
  code: 'XF-ASSEMBLE-017',
  severity: 'warning',
  message: 'xforge/hosts.yaml 读不出来：按空台账继续，这一轮认不出旧的孤儿',
  remedy: { command: 'xforge sync', text: '重投一次台账就回来；投影目录里若有上一版留下的文件，跑 xforge doctor 看还认不认得出' },
});

/**
 * 这个 provider 此刻「我投过哪些文件」的答案：台账里有就用台账（准），
 * 台账对它没得可说就按已知布局扫一遍（兜底）。少了兜底，删一份派生文件就等于让孤儿永久失忆。
 */
export async function footprintOf(root: string, ledger: HostsLedger, provider: Provider): Promise<Array<{ path: string; kind: 'owned' | 'shared' }>> {
  const recorded = ledger.providers.find((x) => x.id === provider.id)?.files;
  if (recorded?.length) return recorded.map((f) => ({ path: f.path, kind: f.kind }));
  return (await provider.footprint(root)).map((f) => ({ path: rel(root, f.path), kind: f.kind }));
}

export interface Projected {
  provider: Provider;
  files: HostFile[];
  /** 这个宿主能执法，但脚手架里没有钩子声明可投。 */
  hookMissing: boolean;
  /** 钩子该落进去的共用文件读不懂（项目根相对路径）：这一次装不进去，而我们不动别人的文件。 */
  hookBlocked: string | null;
}

/** 按当前脚手架与清单算出每个 provider 此刻应该投什么。不写盘。 */
export async function projectedFiles(root: string, paths: GovernancePaths, manifest: Manifest, ids: readonly string[]): Promise<Projected[]> {
  const skills = await loadSkills(paths, manifest.language);
  const executor = await loadExecutor(paths, manifest.language);
  const out: Projected[] = [];
  for (const id of ids) {
    const provider = providerOrThrow(id);
    const hookCommand = await hookCommandFor(paths, provider);
    const blocked = hookCommand === null ? null : ((await provider.hookBlocked?.(root)) ?? null);
    out.push({
      provider,
      hookMissing: canEnforce(provider) && hookCommand === null,
      hookBlocked: blocked === null ? null : rel(root, blocked),
      files: await provider.project({ root, skills, executor, language: manifest.language, hookCommand }),
    });
  }
  return out;
}

export async function loadSkills(paths: GovernancePaths, language: Language): Promise<SkillSource[]> {
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

export async function loadExecutor(paths: GovernancePaths, language: Language): Promise<{ def: Executor; prompt: string } | null> {
  const defPath = paths.executor('xforge-executor');
  if (!(await exists(defPath))) return null;
  const def = await readYaml<Executor>(defPath, 'executor');
  const promptRel = language === 'zh-CN' ? def.prompt_file : def.prompt_file.replace(/_cn\.md$/, '.md');
  const promptPath = join(join(defPath, '..'), promptRel);
  const prompt = (await readText(promptPath)) ?? (await readText(join(join(defPath, '..'), def.prompt_file))) ?? '';
  await stat(defPath);
  return { def, prompt };
}

/** 删掉孤儿以后，空下来的投影目录跟着走；只往上走到项目根，且只删空目录。 */
export async function pruneEmptyDirs(root: string, removed: readonly string[]): Promise<void> {
  for (const r of removed) {
    let dir = join(root, r, '..');
    while (dir.startsWith(root) && dir !== root) {
      try {
        if (readdirSync(dir).length) break;
        rmSync(dir, { recursive: true, force: true }); // 上一行已确认它是空的
      } catch {
        break;
      }
      dir = join(dir, '..');
    }
  }
}
