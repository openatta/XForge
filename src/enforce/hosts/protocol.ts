// design: cli §4 — 宿主协议：一个宿主一份载荷解析 + 一份裁决输出；执法主体不认宿主名，只认这张表。
import type { ToolAction } from '../../model/types.js';
import { claudeProtocol } from './claude.js';
import { codexProtocol } from './codex.js';

/** 一次工具调用，宿主中立。 */
export interface Call {
  action: ToolAction | 'other';
  paths: string[];
  command?: string;
  cwd: string;
}

export type Decision = { decision: 'allow' | 'deny' | 'ask'; reason: string };

/**
 * 一个宿主的执法协议。`parse` 认不出就抛，调用方按失败朝安全拒绝；
 * `render` 回 `null` 表示**什么都不说** —— 这次调用照常走宿主自己的审批与沙箱。
 */
export interface HostProtocol {
  parse(raw: string, fallbackCwd: string): Call;
  render(d: Decision): string | null;
}

/** 键是 `--host` 收到的字符串：认不出的宿主在这里就是查不到，由调用方拒绝（不留默认值兜底）。 */
export const PROTOCOLS: Record<string, HostProtocol> = {
  claude: claudeProtocol,
  codex: codexProtocol,
};

/** 认不出的宿主没有自己的方言可用：裁决在调用方已经是否决，这里只是把话说出去（`hookSpecificOutput` 是这类钩子最通用的一套）。 */
export const FALLBACK_PROTOCOL: HostProtocol = claudeProtocol;
