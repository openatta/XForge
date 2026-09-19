// design: cli §5 — provider 装配侧：接口、注册表、探测、执法钩子命令串、当前宿主。
import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';
import { exists } from '../fs/transaction.js';
import type { GovernancePaths } from '../model/paths.js';
import type { Executor, Hook, Language, Manifest } from '../model/types.js';
import { readYaml } from '../model/yaml.js';
import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';
import type { HostFile, SkillSource } from './shared.js';

export * from './shared.js';

/**
 * 这个宿主能做什么。`enforcement` 点名的是**机制**而不是有无：
 * 将来遇到不靠钩子执法的宿主（比如宿主自己有策略引擎），加一个取值就行，不用改判定的写法。
 */
export interface Capabilities {
  enforcement: 'hook' | 'none';
  isolation: boolean;
}

/** 有没有执法这回事。判定集中在这里，别处不写 `=== 'hook'`。 */
export const canEnforce = (p: Provider): boolean => p.capabilities.enforcement !== 'none';

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
  /** 执法钩子落进哪个**宿主共用文件**（项目根相对）；`enforcement: 'none'` 的 provider 没有这一项。 */
  hookFile?: string;
  project(input: ProjectionInput): Promise<HostFile[]>;
  /** 钩子是否确实在宿主原生位置里；没有执法能力的 provider 恒 false。 */
  hookInstalled(root: string, command: string | null): Promise<boolean>;
  /** 钩子该落进去的共用文件读不懂（于是这一次装不进去）时回它的路径，否则 null。没有这类文件的 provider 不实现。 */
  hookBlocked?(root: string): Promise<string | null>;
  /**
   * 钩子装进去之后还要**宿主那边的人再放行一次**才会跑（codex 的 `/hooks` 信任），
   * 而那一步控制面看不见。置真时 `enforcement` 一律报 `unavailable`：
   * 看不见的事不能当成看见了（D8）。
   */
  hookNeedsHostTrust?: boolean;
  /**
   * 台账没得可说时的兜底：按这个 provider 的已知布局，它此刻可能占着哪些路径（绝对路径）。
   * 台账是派生物 —— 丢一份派生文件不该让「哪些文件是我投的」这个问题永久没有答案。
   */
  footprint(root: string): Promise<Array<{ path: string; kind: 'owned' | 'shared' }>>;
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
  // 带路径分隔符的就是路径本身，不去 PATH 上找。
  if (binary.includes('/') || binary.includes('\\')) {
    try {
      accessSync(binary, constants.X_OK);
      return binary;
    } catch {
      return null;
    }
  }
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

/**
 * 钩子的命令**看起来**跑不跑得起来。注意这只是一个猜测，不是事实：
 * 钩子是**宿主进程**拿这条命令去起的，用的是宿主的 PATH；而我们只看得见自己这个进程的 PATH。
 * 两者不一样是常态（从别的 shell 调 `xforge doctor`、CI、装在 worktree 里的包）。
 *
 * 所以这里放宽到两条任一成立：命令在我们的 PATH 上解析得到，
 * 或者它就是本包自带的那个可执行文件（那说明它随包装好了，宿主从正常 shell 起得来）。
 * 判断结果只用来给一条 `warning`，不参与 `enforcement` 的判定（D8）。
 */
export function hookRunnable(command: string | null, env: NodeJS.ProcessEnv): boolean {
  const binary = command?.trim().split(/\s+/)[0];
  if (!binary) return false;
  if (onPath(binary, env) !== null) return true;
  return ownBin(binary) !== null;
}

/** 本包 `bin/` 下的同名可执行文件（`xforge-enforce` 是我们自己发出去的）。 */
function ownBin(binary: string): string | null {
  for (const name of [binary, `${binary}.js`]) {
    const candidate = fileURLToPath(new URL(`../../bin/${name}`, import.meta.url));
    try {
      accessSync(candidate, constants.F_OK);
      return candidate;
    } catch {
      // 下一个
    }
  }
  return null;
}

/** 执法钩子命令串：声明是唯一出处（规则文件设计 §3.5），provider 不许写死。 */
export async function hookCommandFor(paths: GovernancePaths, provider: Provider): Promise<string | null> {
  if (!canEnforce(provider)) return null;
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
  // 先挑验得出来的那个：两个宿主都能执法时，选需要宿主再放行的那个会让整个项目白白报 unavailable。
  return known.find((p) => canEnforce(p) && !p.hookNeedsHostTrust) ?? known.find((p) => canEnforce(p)) ?? known[0];
}

/**
 * 写入范围此刻拦不拦得住（命令行设计 D8）：当前宿主有执法能力，且钩子确实在它的原生位置里。
 *
 * **只报我们验得出来的。** 「钩子起不起得来」要看宿主进程的 PATH，我们看不见它；
 * 拿自己的 PATH 去替它回答，在两边不一样时就会把「拦得住」报成「拦不住」——
 * 那与反过来谎报同样是错，只是错在另一头。那条猜测留给 `doctor` 的 `XF-ASSEMBLE-014` warning。
 */
export async function enforcementActive(root: string, paths: GovernancePaths, manifest: Manifest, env: NodeJS.ProcessEnv): Promise<boolean> {
  const provider = currentProvider(manifest, env);
  if (!provider || !canEnforce(provider)) return false;
  if (!manifest.platforms.includes(provider.id)) return false;
  // 宿主那边还要人放行一次、而我们看不见那一步：只能报 unavailable。
  if (provider.hookNeedsHostTrust) return false;
  return provider.hookInstalled(root, await hookCommandFor(paths, provider));
}
