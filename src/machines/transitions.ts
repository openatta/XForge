// design: cli §3 — 转换表：表之外的任何 (from, to) 都被拒绝，且不写任何文件（CLI-18）。
// 交付即集成（主文档 5.3，2026-09-17 起）：没有人确认这一格；集成的机械前置（验证门当前、路径在包内）在 --deliver 时查。
import type { PackageState } from './receipts.js';

export const PACKAGE_TRANSITIONS: ReadonlyArray<{ from: PackageState; to: PackageState; by: 'dispatch' | 'deliver' }> = [
  { from: 'ready', to: 'running', by: 'dispatch' },
  { from: 'failed', to: 'running', by: 'dispatch' },
  { from: 'blocked', to: 'running', by: 'dispatch' },
  { from: 'running', to: 'integrated', by: 'deliver' },
  { from: 'running', to: 'failed', by: 'deliver' },
  { from: 'running', to: 'blocked', by: 'deliver' },
];

export function packageMoveAllowed(from: PackageState, to: PackageState, by: 'dispatch' | 'deliver'): boolean {
  return PACKAGE_TRANSITIONS.some((t) => t.from === from && t.to === to && t.by === by);
}

/** `succeeded` 与 `reviewed` 只出现在旧记录里：它们曾是「等人确认」与「已评审」两格。 */
export const TERMINAL_PACKAGE_STATES: ReadonlySet<PackageState> = new Set(['integrated', 'reviewed']);
