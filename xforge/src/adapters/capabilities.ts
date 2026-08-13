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

/** The per-resource projection families `planProjection` can lose a resource in. */
export type ProjectionDimension = 'commands' | 'rules' | 'agents';

/**
 * Which per-resource projection dimensions each target actually emits, declared once here instead
 * of re-derived implicitly at each `planProjection` call site.
 *
 * A `false` entry is a structural, unchanging property of the target: Codex loads Skills, Agents
 * and AGENTS.md only — it has neither a command-file format nor a rule-file format — and OpenCode
 * has commands but no rule files. A resource of that kind therefore cannot be projected there, and
 * `planProjection` reports the gap as `info` rather than dropping it silently.
 *
 * A `true` entry is an assertion about the Adapter: if `commandPath`/`renderCommand`,
 * `rulePath`/`renderRule` or `agentPath`/`renderAgent` returns null anyway, this table and the
 * Adapter disagree and one of them is wrong, so `planProjection` raises a drift `warning`. That
 * branch is unreachable as of today's adapters and exists to catch a future edit to one side only.
 *
 * Guidance is deliberately not a dimension. The repo-root AGENTS.md is produced by
 * `renderGovernance` for every target and never per resource, so no per-resource guidance drop can
 * occur; how faithfully each host honours that file is already recorded by
 * `AdapterCapability.guidance`. Nothing would read a `guidance` column here.
 *
 * This is not derivable from `AdapterCapability`: those levels describe how well a host honours a
 * kind (Codex declares `rules: 'degraded'` because Rules reach it folded into AGENTS.md), whereas
 * this table describes whether a dedicated per-resource artifact is written at all.
 */
export const PROJECTED_DIMENSIONS: Record<TargetId, Record<ProjectionDimension, boolean>> = {
  claude: { commands: true, rules: true, agents: true },
  codex: { commands: false, rules: false, agents: true },
  cursor: { commands: true, rules: true, agents: true },
  opencode: { commands: true, rules: false, agents: true },
  'github-copilot': { commands: true, rules: true, agents: true },
};
