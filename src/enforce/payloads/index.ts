// design: cli §4 — provider 执法侧：每个宿主一份载荷解析与决策渲染。装配侧（src/providers）在这里一个字也够不着（MG-03）。
import type { ToolAction } from '../../model/types.js';
import { claudePayload } from './claude.js';

export interface Call {
  action: ToolAction | 'other';
  paths: string[];
  command?: string;
  cwd: string;
}

export type Decision = { decision: 'allow' | 'deny' | 'ask'; reason: string };

export interface PayloadAdapter {
  id: string;
  /** 宿主发来的载荷 → 一次调用；解析不了就抛（调用方按失败朝安全处理）。 */
  parse(raw: string, fallbackCwd: string): Call;
  /** 决策 → 宿主认得的回答。 */
  render(decision: Decision): string;
}

const REGISTRY: readonly PayloadAdapter[] = [claudePayload];

export function payloadFor(host: string): PayloadAdapter | undefined {
  return REGISTRY.find((a) => a.id === host);
}
