// design: cli §5 — provider 装配侧：接口、注册表、探测、执法钩子命令串、当前宿主。
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { exists } from '../fs/transaction.js';
import type { GovernancePaths } from '../model/paths.js';
import type { Executor, Hook, Language, Manifest } from '../model/types.js';
import { readYaml } from '../model/yaml.js';
import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';
import type { HostFile, SkillSource } from './shared.js';

export * from './shared.js';

/** 这个宿主能做什么：执法钩子、隔离的执行者。 */
export interface Capabilities {
  enforcement: boolean;
  isolation: boolean;
}

/** 本机装没装。`why` 说明为什么判成没装（给人看，不参与判定）。 */
export interface Detection {
  installed: boolean;
  version?: string;
  path?: string;
  why?: string;
}

export interface ProjectionInput {
  root: string;
  skills: readonly SkillSource[];
  executor: { def: Executor; prompt: string } | null;
  language: Language;
  /** 执法钩子命令串（`scaffold/hooks/enforce.yaml` 展开后）；没有声明或没有执法能力时是 null。 */
  hookCommand: string | null;
}

export interface Provider {
  id: string;
  displayName: string;
  /** 探测时找的可执行文件名。 */
  binary: string;
  capabilities: Capabilities;
  project(input: ProjectionInput): Promise<HostFile[]>;
  /** 钩子是否确实在宿主原生位置里；没有执法能力的 provider 恒 false。 */
  hookInstalled(root: string, command: string | null): Promise<boolean>;
  /** 从共用文件里摘掉我们那块（块外逐字节保留）；不归我们管就回 null。 */
  detach(root: string, path: string): Promise<HostFile | null>;
}

const REGISTRY: readonly Provider[] = [claudeProvider, codexProvider];

export function providers(): readonly Provider[] {
  return REGISTRY;
}

export function providerFor(id: string): Provider | undefined {
  return REGISTRY.find((p) => p.id === id);
}

export function knownProviderIds(): string[] {
  return REGISTRY.map((p) => p.id);
}

/**
 * 探测：`XFORGE_DETECT=claude:2.1.0,codex:none` 注入时以它为准（CI 与测试用），
 * 否则在 PATH 上找可执行文件。不启动子进程：探测是装配期的提示，不值得一次 spawn。
 */
export function detect(provider: Provider, env: NodeJS.ProcessEnv): Detection {
  const injected = parseDetect(env['XFORGE_DETECT']);
  if (injected) {
    const hit = injected.get(provider.id);
    if (!hit || hit === 'none') return { installed: false, why: 'XFORGE_DETECT 说没装' };
    return hit === 'yes' ? { installed: true } : { installed: true, version: hit };
  }
  const found = onPath(provider.binary, env);
  return found ? { installed: true, path: found } : { installed: false, why: `PATH 上没有 ${provider.binary}` };
}

/** `id:版本` / `id:none` / `id:yes`，逗号分隔。 */
export function parseDetect(raw: string | undefined): Map<string, string> | null {
  if (raw === undefined) return null;
  const out = new Map<string, string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf(':');
    if (i === -1) out.set(trimmed, 'yes');
    else out.set(trimmed.slice(0, i).trim(), trimmed.slice(i + 1).trim() || 'yes');
  }
  return out;
}

function onPath(binary: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 下一个
    }
  }
  return null;
}

/** 执法钩子命令串：声明是唯一出处（规则文件设计 §3.5），provider 不许写死。 */
export async function hookCommandFor(paths: GovernancePaths, provider: Provider): Promise<string | null> {
  if (!provider.capabilities.enforcement) return null;
  const path = paths.hook('enforce');
  if (!(await exists(path))) return null;
  const hook = await readYaml<Hook>(path, 'hook');
  return hook.command.split('${platform}').join(provider.id);
}

/**
 * 当前正在跑的宿主：`XFORGE_HOST` 指定；否则清单里第一个能执法的；再否则清单里第一个认得的。
 * 「清单里有 claude」不等于「此刻跑在 claude 里」—— 混装项目上只看清单会谎报（命令行设计 D8）。
 */
export function currentProvider(manifest: Manifest, env: NodeJS.ProcessEnv): Provider | undefined {
  const named = env['XFORGE_HOST'];
  if (named) return providerFor(named);
  const known = manifest.platforms.map((id) => providerFor(id)).filter((p): p is Provider => p !== undefined);
  return known.find((p) => p.capabilities.enforcement) ?? known[0];
}

/** 写入范围此刻拦不拦得住：当前宿主有执法能力，且钩子确实在原生位置里。 */
export async function enforcementActive(root: string, paths: GovernancePaths, manifest: Manifest, env: NodeJS.ProcessEnv): Promise<boolean> {
  const provider = currentProvider(manifest, env);
  if (!provider || !provider.capabilities.enforcement) return false;
  if (!manifest.platforms.includes(provider.id)) return false;
  return provider.hookInstalled(root, await hookCommandFor(paths, provider));
}
