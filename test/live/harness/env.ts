// design: live-test §3 — 一个驱动、两套环境：claude 用本机凭据；gateway 只透传 .env 里的那批变量。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Engine = 'claude' | 'gateway';

const OVERRIDE_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_'];

/** 解析 `export K=V` / `K=V` 行；不求值、不展开。 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

/**
 * claude：继承完整环境（本机认证依赖其中的变量），只覆盖配置目录。
 * gateway：从完整环境里去掉全部 ANTHROPIC_* / CLAUDE_CODE_* 覆盖，再只注入 .env 里的那批；
 * 代理变量也去掉 —— 网关直连比走代理快得多（用户 2026-09-17 要求：B 不走代理，A 走），.env 里显式写了才用。
 */
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
export function engineEnv(engine: Engine, repoRoot: string, claudeConfigDir: string, shimDir: string): NodeJS.ProcessEnv {
  // shim 目录放最前：项目里的 `xforge` / `xforge-enforce` 必须是本仓库的 bin，不是 PATH 上任何旧版。
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir, PATH: `${shimDir}:${process.env['PATH'] ?? ''}` };
  if (engine === 'gateway') {
    for (const k of Object.keys(env)) if (OVERRIDE_PREFIXES.some((p) => k.startsWith(p)) || PROXY_VARS.includes(k)) delete env[k];
    const dotenv = parseDotEnv(readFileSync(join(repoRoot, '.env'), 'utf8'));
    for (const [k, v] of Object.entries(dotenv)) if (OVERRIDE_PREFIXES.some((p) => k.startsWith(p)) || PROXY_VARS.includes(k)) env[k] = v;
    if (!env['ANTHROPIC_AUTH_TOKEN'] || !env['ANTHROPIC_BASE_URL']) throw new Error('.env 里要同时有 ANTHROPIC_AUTH_TOKEN 与 ANTHROPIC_BASE_URL 才能用 gateway 引擎');
  }
  return env;
}

export function engineModel(env: NodeJS.ProcessEnv): string | undefined {
  return env['ANTHROPIC_MODEL'];
}
