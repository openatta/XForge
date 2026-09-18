// design: cli §5.4 — 探测本机装了哪些宿主：三路证据，一处实现，谁要谁拿去用。
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { provider, type HostProvider } from '../hosts/index.js';
import type { Platform } from '../model/types.js';

export interface Presence {
  available: boolean;
  /** 证据，也是列表里那一列备注的一半；三路证据里最弱的一路也要说清是哪一路。 */
  evidence: string;
}

/** 用户主目录：环境变量优先，测试与容器里好摆布。 */
export function homeOf(env: NodeJS.ProcessEnv): string {
  return env['HOME'] ?? homedir();
}

/** `PATH` 上的可执行文件。不在 `PATH` 不等于没装，所以这只是三路证据里最弱的一路。 */
export function onPath(binary: string, env: NodeJS.ProcessEnv): boolean {
  const path = env['PATH'] ?? env['Path'] ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return true; // 目录也「可执行」，那不算一个二进制
    } catch {
      // 往下找
    }
  }
  return false;
}

/** 会话环境变量 > 用户级配置目录 > `PATH`。顺序是证据强度，也是这个函数回话的顺序。 */
export function detect(p: HostProvider, env: NodeJS.ProcessEnv, home: string): Presence {
  for (const name of p.detection.sessionEnv) if (env[name]) return { available: true, evidence: 'found: this session' };
  if (existsSync(join(home, p.detection.homeConfigDir))) return { available: true, evidence: `found: ~/${p.detection.homeConfigDir}` };
  for (const binary of p.detection.binaries) if (onPath(binary, env)) return { available: true, evidence: `found: ${binary} on PATH` };
  return { available: false, evidence: 'not detected' };
}

/** 清单里每个宿主的在场情况。`init` 拿它画列表，`doctor` 拿它做体检。 */
export function detectAll(platforms: readonly Platform[], env: NodeJS.ProcessEnv): Array<{ id: Platform; presence: Presence }> {
  const home = homeOf(env);
  return platforms.map((id) => ({ id, presence: detect(provider(id), env, home) }));
}
