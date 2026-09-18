// design: cli §5.2 — 投影怎么算只有一处实现：sync 拿它写盘，doctor 拿它比对。
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { exists, readText } from '../fs/transaction.js';
import { provider, type HostFile, type ProjectionContext, type SkillSource } from '../hosts/index.js';
import type { GovernancePaths } from '../model/paths.js';
import type { Executor, Hook, Language, Manifest, Platform } from '../model/types.js';
import { parseYaml, readYaml } from '../model/yaml.js';

/**
 * 执法钩子声明（`scaffold/hooks/enforce.yaml`）。读不到就退回内置声明 ——
 * 投影不能因为载荷缺一个文件就静默不装钩子（那是 fail-open）；缺文件由 `doctor` 报出来。
 */
export const DEFAULT_HOOK: Hook = { name: 'enforce', events: ['pre-tool-use'], command: 'xforge-enforce --host ${platform}' };

/**
 * 事务里还没落盘的写入。`repair` 补骨架与重投影是同一个事务，投影得先看得见补回来的那几份 ——
 * 否则补回去的 Skill 要等下一次 `sync` 才投影，这一轮就白补了。
 */
export type Overlay = ReadonlyMap<string, string>;

const textOf = async (path: string, overlay: Overlay): Promise<string | null> => overlay.get(path) ?? (await readText(path));
const hasOf = async (path: string, overlay: Overlay): Promise<boolean> => overlay.has(path) || (await exists(path));

/**
 * 载荷里某份文件读不出来时**不抛错也不静默**的中间态：调用方拿到 null，
 * 由 `doctor` 的骨架检查去说「本该有它」。sync 少投影一个 Skill 不是它该嚷嚷的事。
 */
async function loadSkills(paths: GovernancePaths, language: Language, overlay: Overlay): Promise<SkillSource[]> {
  const out: SkillSource[] = [];
  for (const name of await skillNames(paths, overlay)) {
    const text = await textOf(paths.skill(name, language), overlay);
    if (text !== null) out.push({ name, text });
  }
  return out;
}

export async function loadHook(paths: GovernancePaths, overlay: Overlay = new Map()): Promise<Hook | null> {
  const path = paths.hook('enforce');
  if (!(await hasOf(path, overlay))) return DEFAULT_HOOK;
  try {
    const text = overlay.get(path);
    return text !== undefined ? parseYaml<Hook>(text, 'hook', path) : await readYaml<Hook>(path, 'hook');
  } catch {
    return DEFAULT_HOOK;
  }
}

async function loadExecutor(paths: GovernancePaths, language: Language, overlay: Overlay): Promise<{ def: Executor; prompt: string } | null> {
  const defPath = paths.executor('xforge-executor');
  if (!(await hasOf(defPath, overlay))) return null;
  const def = await readYaml<Executor>(defPath, 'executor');
  const promptRel = language === 'zh-CN' ? def.prompt_file : def.prompt_file.replace(/_cn\.md$/, '.md');
  const dir = join(defPath, '..');
  const prompt = (await textOf(join(dir, promptRel), overlay)) ?? (await textOf(join(dir, def.prompt_file), overlay)) ?? '';
  return { def, prompt };
}

export async function projectionContext(root: string, paths: GovernancePaths, manifest: Manifest, overlay: Overlay = new Map()): Promise<ProjectionContext> {
  return {
    root,
    skills: await loadSkills(paths, manifest.language, overlay),
    executor: await loadExecutor(paths, manifest.language, overlay),
    language: manifest.language,
    hook: await loadHook(paths, overlay),
  };
}

/** 这批宿主现在该有的全部投影文件（绝对路径 + 内容）。 */
export async function projections(ctx: ProjectionContext, platforms: readonly Platform[]): Promise<HostFile[]> {
  return (await Promise.all(platforms.map((p) => provider(p).files(ctx)))).flat();
}

/** 骨架里有哪些 Skill 目录（含事务里刚补回来的）；缺的源文件由 doctor 报，这里只列名字。 */
export async function skillNames(paths: GovernancePaths, overlay: Overlay = new Map()): Promise<string[]> {
  const dir = join(paths.scaffold, 'skills');
  const names = new Set<string>();
  if (existsSync(dir)) for (const d of await readdir(dir, { withFileTypes: true })) if (d.isDirectory()) names.add(d.name);
  const prefix = dir + sep;
  for (const path of overlay.keys()) if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split(sep)[0]!);
  return [...names].sort();
}
