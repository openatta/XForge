// design: cli §5 — 宿主投影的计算与台账：sync 投它、doctor 验它、repair 修它，三个命令同一份算法。
import { readdir, stat } from 'node:fs/promises';
import { readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CliError } from '../cli/errors.js';
import { exists, readText } from '../fs/transaction.js';
import type { GovernancePaths } from '../model/paths.js';
import type { Executor, HostsLedger, Language, Manifest } from '../model/types.js';
import { readYaml } from '../model/yaml.js';
import { hookCommandFor, knownProviderIds, providerFor, type HostFile, type Provider, type SkillSource } from '../providers/index.js';

/** 项目根相对的 posix 路径：台账里的键。 */
export function rel(root: string, path: string): string {
  return relative(root, path).split('\\').join('/');
}

export function providerOrThrow(id: string): Provider {
  const provider = providerFor(id);
  if (provider) return provider;
  throw new CliError('XF-ASSEMBLE-005', `清单里的 ${id} 不是这个版本认得的 provider`, 1, { command: 'xforge doctor', text: `认得的是：${knownProviderIds().join('、')}` });
}

export async function readLedger(paths: GovernancePaths): Promise<HostsLedger> {
  if (!(await exists(paths.hostsLedger))) return { version: 1, providers: [] };
  return readYaml<HostsLedger>(paths.hostsLedger, 'hosts');
}

export interface Projected {
  provider: Provider;
  files: HostFile[];
  /** 这个宿主能执法，但脚手架里没有钩子声明可投。 */
  hookMissing: boolean;
}

/** 按当前脚手架与清单算出每个 provider 此刻应该投什么。不写盘。 */
export async function projectedFiles(root: string, paths: GovernancePaths, manifest: Manifest, ids: readonly string[]): Promise<Projected[]> {
  const skills = await loadSkills(paths, manifest.language);
  const executor = await loadExecutor(paths, manifest.language);
  const out: Projected[] = [];
  for (const id of ids) {
    const provider = providerOrThrow(id);
    const hookCommand = await hookCommandFor(paths, provider);
    out.push({
      provider,
      hookMissing: provider.capabilities.enforcement && hookCommand === null,
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
