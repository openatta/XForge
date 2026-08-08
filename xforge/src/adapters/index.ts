import type { TargetId } from '../constants.js';
import type { AdapterCapability } from '../types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { githubCopilotAdapter } from './github-copilot.js';
import { opencodeAdapter } from './opencode.js';
import type { Adapter } from './types.js';

const adapters = new Map<TargetId, Adapter>([
  ['claude', claudeAdapter],
  ['codex', codexAdapter],
  ['cursor', cursorAdapter],
  ['opencode', opencodeAdapter],
  ['github-copilot', githubCopilotAdapter],
]);

export function getAdapter(target: TargetId): Adapter {
  const adapter = adapters.get(target);
  if (!adapter) throw new Error(`Adapter not registered: ${target}`);
  return adapter;
}

export function capabilityMatrix(targets: TargetId[]): Record<TargetId, AdapterCapability> {
  return Object.fromEntries(targets.map((target) => [target, getAdapter(target).capability])) as Record<TargetId, AdapterCapability>;
}

export type { Adapter } from './types.js';
