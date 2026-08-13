import type { TargetId } from '../constants.js';
import type { AdapterCapability } from '../types.js';

/**
 * Single source of truth for the two capability dimensions that are cross-checked at projection
 * time. They live here rather than inline in each adapter so `governance.ts` can consult them
 * without importing `adapters/index.ts` (which imports the adapters, which import governance).
 *
 * The rule these tables must satisfy: an event or capability listed here is one the projection
 * actually emits something real for. If a target cannot express it, it is absent and
 * `planProjection` reports the gap instead of dropping it silently.
 */

/** Canonical XForge Hook events each target's runtime bridge really receives. */
export const RUNTIME_HOOK_EVENTS: Record<TargetId, string[]> = {
  claude: [
    'agent.session.start', 'agent.session.end', 'agent.prompt.submit', 'agent.tool.before',
    'agent.tool.after', 'agent.permission.request', 'agent.subagent.start', 'agent.subagent.stop', 'agent.turn.stop',
  ],
  codex: [
    'agent.session.start', 'agent.session.end', 'agent.prompt.submit', 'agent.tool.before',
    'agent.tool.after', 'agent.permission.request', 'agent.subagent.start', 'agent.subagent.stop', 'agent.turn.stop',
  ],
  cursor: [
    'agent.session.start', 'agent.session.end', 'agent.prompt.submit', 'agent.tool.before',
    'agent.tool.after', 'agent.turn.stop',
  ],
  // The OpenCode bridge is a plugin that subscribes to `tool.execute.before` / `tool.execute.after`
  // only. Session, prompt and turn events are not wired, so they are not claimed.
  opencode: ['agent.tool.before', 'agent.tool.after', 'agent.permission.request'],
  'github-copilot': [
    'agent.session.start', 'agent.session.end', 'agent.prompt.submit', 'agent.tool.before',
    'agent.tool.after', 'agent.turn.stop',
  ],
};

/**
 * What each target's static permission layer can express.
 *
 * No target can express `exceptActors` or `match.stages`: Claude's `permissions.deny` is a
 * platform-level refusal evaluated before the PreToolUse hook runs, Codex `prefix_rule` decisions
 * carry no actor, and OpenCode `permission` patterns match tool input only. Policies using those
 * dimensions are therefore withheld from the static layer and left to the runtime bridge, which
 * does implement both.
 */
export const PERMISSION_POLICY_SCOPES: Record<TargetId, NonNullable<AdapterCapability['permissionPolicyScopes']>> = {
  claude: { capabilities: ['fs.read', 'fs.write', 'shell', 'network', 'subagent', 'mcp'], actorScoped: false, stageScoped: false },
  codex: { capabilities: ['shell'], actorScoped: false, stageScoped: false },
  cursor: { capabilities: [], actorScoped: false, stageScoped: false },
  opencode: { capabilities: ['fs.read', 'fs.write', 'shell', 'network', 'subagent', 'external.write'], actorScoped: false, stageScoped: false },
  'github-copilot': { capabilities: [], actorScoped: false, stageScoped: false },
};

/**
 * Which per-resource projection families each target actually emits. A `false` entry is a
 * structural, unchanging property of the target (Codex has no command files and no rule files —
 * it loads Skills, Agents, and AGENTS.md only), so `planProjection` reports the resources that
 * target cannot express instead of dropping them silently. `guidance` is `true` for every target:
 * the repo-root AGENTS.md is projected regardless of selected targets, and the capability level
 * only describes how faithfully the host honours it, so no per-resource guidance gap can occur.
 */
export const PROJECTED_DIMENSIONS: Record<TargetId, { commands: boolean; rules: boolean; guidance: boolean }> = {
  claude: { commands: true, rules: true, guidance: true },
  codex: { commands: false, rules: false, guidance: true },
  cursor: { commands: true, rules: true, guidance: true },
  opencode: { commands: true, rules: false, guidance: true },
  'github-copilot': { commands: true, rules: true, guidance: true },
};
