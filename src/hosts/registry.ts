// design: skills §5 — 宿主注册表：加一个宿主 = 一个文件 + 一处登记；其余代码按能力查询，不认宿主名。
import type { Platform } from '../model/types.js';
import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';
import type { HostProvider } from './shared.js';

export const PROVIDERS: Record<Platform, HostProvider> = {
  claude: claudeProvider,
  codex: codexProvider,
};

/** 登记顺序 = 交互列表顺序 = `--platform all` 的展开顺序。 */
export const PLATFORMS = Object.keys(PROVIDERS) as Platform[];

export function provider(id: Platform): HostProvider {
  return PROVIDERS[id];
}

export function isPlatform(value: string): value is Platform {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/**
 * 这批宿主里有没有一个带执法钩子的。项目级问题，不是「装没装某个特定宿主」——
 * 声明了 claude + codex 的项目，钩子是装上的，`orient.enforcement` 就该是 `available`。
 */
export function enforcementAvailable(platforms: readonly Platform[]): boolean {
  return platforms.some((p) => PROVIDERS[p].capabilities.enforcement === 'hook');
}
