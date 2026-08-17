import type { TargetId } from '../constants.js';
import type { DesiredFile, Diagnostic, HookResource, PermissionPolicyResource } from '../types.js';
import { diagnostic } from '../core/errors.js';
import { targetToolNames } from '../core/tool-capability.js';
import { RUNTIME_HOOK_EVENTS } from './capabilities.js';
import type { GovernanceProjection, GovernanceProjectionInput } from './types.js';

type PolicyItem = { id: string; value: PermissionPolicyResource; yamlPath: string };

const EVENT_MAP: Record<TargetId, Record<string, string>> = {
  codex: {
    'agent.session.start': 'SessionStart', 'agent.session.end': 'SessionEnd', 'agent.prompt.submit': 'UserPromptSubmit',
    'agent.tool.before': 'PreToolUse', 'agent.tool.after': 'PostToolUse', 'agent.permission.request': 'PermissionRequest',
    'agent.subagent.start': 'SubagentStart', 'agent.subagent.stop': 'SubagentStop', 'agent.turn.stop': 'Stop',
  },
  claude: {
    'agent.session.start': 'SessionStart', 'agent.session.end': 'SessionEnd', 'agent.prompt.submit': 'UserPromptSubmit',
    'agent.tool.before': 'PreToolUse', 'agent.tool.after': 'PostToolUse', 'agent.permission.request': 'PermissionRequest',
    'agent.subagent.start': 'SubagentStart', 'agent.subagent.stop': 'SubagentStop', 'agent.turn.stop': 'Stop',
  },
  // `agent.permission.request` deliberately absent: Cursor has no distinct permission event, and
  // mapping it onto `preToolUse` as well double-registered the dispatcher on a single event.
  cursor: {
    'agent.session.start': 'sessionStart', 'agent.session.end': 'sessionEnd', 'agent.prompt.submit': 'beforeSubmitPrompt',
    'agent.tool.before': 'preToolUse', 'agent.tool.after': 'postToolUse', 'agent.turn.stop': 'stop',
  },
  'github-copilot': {
    'agent.session.start': 'sessionStart', 'agent.session.end': 'sessionEnd', 'agent.prompt.submit': 'userPromptSubmitted',
    'agent.tool.before': 'preToolUse', 'agent.tool.after': 'postToolUse', 'agent.turn.stop': 'agentStop',
  },
  opencode: {},
};

/**
 * The command a host runs to ask XForge whether a tool call is allowed.
 *
 * A bare `xforge`, not `npx --no-install xforge`. v0.7.12 moved the CLI to a global install
 * precisely because a project need not be a Node project, and this dispatcher was the last thing
 * still assuming otherwise: with no project `node_modules`, `npx --no-install` silently falls
 * through to whatever `xforge` is on the ambient PATH. That is exactly what a bare `xforge` does,
 * only without pretending the resolution was project-scoped — and when the two disagree, npx
 * resolves the project-local copy while every documented command resolves the global one, so a
 * project could be governed by a different build than the one it runs.
 *
 * The resolved CLI is not necessarily this one, and cannot be: hooks are spawned by the host, in an
 * environment nobody here controls. That is why `hook dispatch` checks the identity of whatever
 * answered against the project's Manifest before deciding anything — see `commands/hook.ts`. A
 * mismatch that used to surface as an unexplained resource-loading failure now says what it is.
 */
function dispatcher(target: TargetId, event: string): string {
  return `xforge hook dispatch --target ${target} --event ${event}`;
}

function desired(target: TargetId, version: string, path: string, content: string, id: string, sources: string[], fragment?: DesiredFile['fragment']): DesiredFile {
  return {
    path, content: Buffer.from(content), source: `governance:${id}`, target,
    resource: { kind: 'governance', id }, sourcePaths: sources, renderVersion: `${target}:governance:${version}`,
    ...(fragment ? { fragment } : {}),
  };
}

function enabledRuntimeHooks(input: GovernanceProjectionInput): Array<{ id: string; value: HookResource; yamlPath: string }> {
  return input.hooks.filter((item) => item.value.spec.enabled && (item.value.spec.plane ?? 'runtime') === 'runtime');
}

/**
 * A policy reaches the static layer only when the static layer can express all of it.
 * `exceptActors` and `match.stages` have no representation in any host's permission format, and a
 * flattened rule would be strictly wrong: Claude's `permissions.deny` is a hard platform refusal
 * evaluated *before* the PreToolUse hook, so a flattened `protected-files` deny would block the
 * Integrator from the very writes `xforge-apply` requires of it. Those policies are routed to the
 * runtime bridge alone, which honours both dimensions, and the omission is reported by
 * `planProjection` rather than left invisible.
 */
export function staticLayerEligible(policy: PermissionPolicyResource): boolean {
  return !(policy.spec.exceptActors?.length) && !(policy.spec.match.stages?.length);
}

function staticPolicies(input: GovernanceProjectionInput): PolicyItem[] {
  return input.policies.filter((item) => staticLayerEligible(item.value));
}

function policySources(input: GovernanceProjectionInput): string[] {
  return [...input.policies.map((item) => item.yamlPath), ...enabledRuntimeHooks(input).map((item) => item.yamlPath)];
}

function hookEntries(target: TargetId, input: GovernanceProjectionInput, format: 'grouped' | 'cursor' | 'copilot'): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const hook of enabledRuntimeHooks(input)) {
    if (!RUNTIME_HOOK_EVENTS[target].includes(hook.value.spec.event)) continue;
    const platformEvent = EVENT_MAP[target][hook.value.spec.event];
    if (!platformEvent) continue;
    const command = dispatcher(target, hook.value.spec.event);
    const matcher = hook.value.spec.matcher && hook.value.spec.matcher !== '*' ? hook.value.spec.matcher : undefined;
    const entry = format === 'grouped'
      ? { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: hook.value.spec.timeoutSeconds }] }
      : format === 'cursor'
        ? { command, timeout: hook.value.spec.timeoutSeconds, ...(matcher ? { matcher } : {}) }
        : { type: 'command', command, bash: command, cwd: '.', timeoutSec: hook.value.spec.timeoutSeconds, ...(matcher ? { matcher } : {}) };
    (result[platformEvent] ??= []).push(entry);
  }
  return result;
}

/**
 * Claude Code permission rule syntax, per the documented forms:
 * `Bash(cmd)`, `Read(path)`, `Edit(path)`, `WebFetch(domain:host)`, `Agent(name)`,
 * `mcp__<server>__*`. Notably `Write(path)` rules are accepted but never consulted for file
 * permission checks (Claude Code warns at startup and tells you to use `Edit(path)`), so the
 * previous `Edit(...)` + `Write(...)` pair is reduced to `Edit(...)` alone.
 */
function claudePermissionRule(policy: PermissionPolicyResource, yamlPath: string, diagnostics: Diagnostic[]): string[] {
  const match = policy.spec.match;
  const effect = policy.spec.effect;
  if (policy.spec.capability === 'fs.read') return (match.paths ?? ['**']).map((value) => `Read(${value})`);
  if (policy.spec.capability === 'fs.write') return (match.paths ?? ['**']).map((value) => `Edit(${value})`);
  if (policy.spec.capability === 'shell') return (match.commands ?? ['*']).map((value) => `Bash(${value})`);
  if (policy.spec.capability === 'network') return (match.hosts ?? ['*']).map((value) => `WebFetch(domain:${value})`);
  if (policy.spec.capability === 'subagent') return (match.tools ?? ['*']).map((value) => `Agent(${value})`);
  if (policy.spec.capability === 'mcp') {
    // Claude Code accepts tool-name globs in deny/ask rules (`mcp__*` = every MCP tool) but in
    // allow rules the server segment must be literal; an unanchored allow glob is skipped with a
    // warning and grants nothing. Emit the documented form or nothing, never a dead rule.
    return (match.mcpServers ?? ['*']).flatMap((value) => {
      if (value !== '*' && !value.includes('*')) return [`mcp__${value}__*`];
      if (effect === 'allow') {
        diagnostics.push(diagnostic(
          'XFORGE_POLICY_RULE_NOT_EXPRESSIBLE',
          `Claude Code ignores allow rules whose MCP server segment is a wildcard, so PermissionPolicy ${policy.metadata.name} emits no static allow rule for mcpServers "${value}"; name the servers explicitly or rely on the runtime bridge.`,
          yamlPath,
          'warning',
          { target: 'claude', capability: 'mcp', mcpServer: value },
        ));
        return [];
      }
      return [value === '*' ? 'mcp__*' : `mcp__${value}`];
    });
  }
  return [];
}

function renderClaude(input: GovernanceProjectionInput, version: string): GovernanceProjection {
  const diagnostics: Diagnostic[] = [];
  const permissions: Record<'allow' | 'ask' | 'deny', string[]> = { allow: [], ask: [], deny: [] };
  for (const policy of staticPolicies(input)) {
    permissions[policy.value.spec.effect].push(...claudePermissionRule(policy.value, policy.yamlPath, diagnostics));
  }
  const hooks = hookEntries('claude', input, 'grouped');
  if (input.policies.length > 0) {
    (hooks.PreToolUse ??= []).unshift({ matcher: '*', hooks: [{ type: 'command', command: dispatcher('claude', 'agent.tool.before'), timeout: 10 }] });
  }
  const rules = Object.fromEntries(Object.entries(permissions)
    .map(([key, value]) => [key, [...new Set(value)].sort()] as const)
    .filter(([, value]) => value.length > 0));
  if (Object.keys(rules).length === 0 && Object.keys(hooks).length === 0) return { files: [], diagnostics };

  // `.claude/settings.json` is the normal home for a team's own Claude Code settings, so XForge
  // owns only the individual rules and hook entries it generates and leaves the rest untouched.
  const fragment: DesiredFile['fragment'] = {
    format: 'json',
    arrays: [
      ...Object.entries(rules).map(([key, items]) => ({ path: ['permissions', key], items: items as unknown[] })),
      ...Object.entries(hooks).sort(([left], [right]) => left.localeCompare(right)).map(([event, items]) => ({ path: ['hooks', event], items })),
    ],
  };
  const preview = { ...(Object.keys(rules).length > 0 ? { permissions: rules } : {}), ...(Object.keys(hooks).length > 0 ? { hooks } : {}) };
  return {
    files: [desired('claude', version, '.claude/settings.json', `${JSON.stringify(preview, null, 2)}\n`, 'settings', policySources(input), fragment)],
    diagnostics,
  };
}

function codexRule(policy: PermissionPolicyResource): string | null {
  if (policy.spec.capability !== 'shell' || !(policy.spec.match.commands?.length)) return null;
  const decision = { allow: 'allow', ask: 'prompt', deny: 'forbidden' }[policy.spec.effect];
  return `${policy.spec.match.commands.map((command) => {
    const pattern = command.trim().split(/\s+/).filter((token) => token !== '*').map((token) => JSON.stringify(token));
    return `prefix_rule(\n  pattern = [${pattern.join(', ')}],\n  decision = ${JSON.stringify(decision)},\n  justification = ${JSON.stringify(policy.spec.reason)},\n)`;
  }).join('\n\n')}\n`;
}

function renderCodex(input: GovernanceProjectionInput, version: string): GovernanceProjection {
  const files: DesiredFile[] = [];
  for (const policy of staticPolicies(input)) {
    const content = codexRule(policy.value);
    if (content) files.push(desired('codex', version, `.codex/rules/xforge-${policy.id}.rules`, content, `permission-${policy.id}`, [policy.yamlPath]));
  }
  const hooks = hookEntries('codex', input, 'grouped');
  if (input.policies.some((item) => item.value.spec.capability !== 'shell' || !staticLayerEligible(item.value))) {
    (hooks.PreToolUse ??= []).unshift({ matcher: '*', hooks: [{ type: 'command', command: dispatcher('codex', 'agent.tool.before'), timeout: 10, statusMessage: 'Evaluating XForge policy' }] });
  }
  if (Object.keys(hooks).length > 0) files.push(desired('codex', version, '.codex/hooks.json', `${JSON.stringify({ description: 'XForge runtime governance bridge. Review and trust this exact definition in Codex.', hooks }, null, 2)}\n`, 'hooks', policySources(input)));
  return { files, diagnostics: [] };
}

/**
 * Cursor's `PreToolUse` hook matcher is a regex alternation of its own tool names (capitalised),
 * with the namespaced MCP form (`MCP:<server>.<tool>`) matched by a `MCP:.*` wildcard branch. Built
 * from `TARGET_TOOLS.cursor` (via {@link targetToolNames}) rather than hand-listed here, so the
 * matcher and the capability table it must agree with can never drift apart.
 */
function cursorPreToolUseMatcher(): string {
  const branches = targetToolNames('cursor').map((name) => (name === 'mcp' ? 'MCP:.*' : `${name[0]!.toUpperCase()}${name.slice(1)}`));
  return [...new Set(branches)].join('|');
}

function renderCursor(input: GovernanceProjectionInput, version: string): GovernanceProjection {
  const hooks = hookEntries('cursor', input, 'cursor');
  if (input.policies.length > 0) (hooks.preToolUse ??= []).unshift({ command: dispatcher('cursor', 'agent.tool.before'), timeout: 10, matcher: cursorPreToolUseMatcher() });
  if (Object.keys(hooks).length === 0) return { files: [], diagnostics: [] };
  return {
    files: [desired('cursor', version, '.cursor/hooks.json', `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, 'hooks', policySources(input))],
    diagnostics: [],
  };
}

function renderCopilot(input: GovernanceProjectionInput, version: string): GovernanceProjection {
  const hooks = hookEntries('github-copilot', input, 'copilot');
  if (input.policies.length > 0) (hooks.preToolUse ??= []).unshift({ type: 'command', command: dispatcher('github-copilot', 'agent.tool.before'), bash: dispatcher('github-copilot', 'agent.tool.before'), cwd: '.', timeoutSec: 10 });
  if (Object.keys(hooks).length === 0) return { files: [], diagnostics: [] };
  return {
    files: [desired('github-copilot', version, '.github/hooks/xforge.json', `${JSON.stringify({ version: 1, disableAllHooks: false, hooks }, null, 2)}\n`, 'hooks', policySources(input))],
    diagnostics: [],
  };
}

/**
 * OpenCode keys permissions by *tool name* under a singular `permission` object, with an optional
 * inner object of input patterns. The previous projection emitted a plural `permissions` array of
 * `{action, resource, effect}` records, which OpenCode does not recognise and silently ignores.
 */
const OPENCODE_PERMISSION_KEY: Record<PermissionPolicyResource['spec']['capability'], string | null> = {
  'fs.read': 'read', 'fs.write': 'edit', shell: 'bash', network: 'webfetch',
  subagent: 'task', 'external.write': 'external_directory', mcp: null,
};

function openCodePatterns(policy: PermissionPolicyResource): string[] {
  const match = policy.spec.match;
  const capability = policy.spec.capability;
  const values = capability === 'shell' ? match.commands
    : capability === 'network' ? match.hosts
      : capability === 'subagent' ? match.tools
        : match.paths;
  return values?.length ? values : ['*'];
}

function renderOpenCode(input: GovernanceProjectionInput, version: string): GovernanceProjection {
  const files: DesiredFile[] = [];
  const diagnostics: Diagnostic[] = [];
  const weight = { allow: 0, ask: 1, deny: 2 } as const;
  const merged = new Map<string, { key: string; pattern: string; effect: 'allow' | 'ask' | 'deny' }>();

  for (const policy of staticPolicies(input)) {
    const key = OPENCODE_PERMISSION_KEY[policy.value.spec.capability];
    if (!key) continue;
    for (const pattern of openCodePatterns(policy.value)) {
      const id = `${key} ${pattern}`;
      const existing = merged.get(id);
      // deny > ask > allow when several policies land on the same tool + pattern.
      if (!existing || weight[policy.value.spec.effect] > weight[existing.effect]) {
        merged.set(id, { key, pattern, effect: policy.value.spec.effect });
      }
    }
  }

  if (merged.size > 0) {
    // OpenCode evaluates object rules in order with the LAST match winning, and recommends the
    // catch-all first. Emit general patterns before specific ones so a narrow deny is not
    // overridden by a broad allow that happens to sort after it.
    const entries = [...merged.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
      || Number(right.pattern === '*') - Number(left.pattern === '*')
      || left.pattern.length - right.pattern.length
      || left.pattern.localeCompare(right.pattern));
    const fragment: DesiredFile['fragment'] = {
      format: 'json',
      // What to write *if* `opencode.json` is missing, nothing more: `applyFragment` never applies
      // a seed to a file that already exists, and `planFragments` records it only for a destination
      // XForge actually created. It is deliberately not a claim of ownership over `$schema` — the
      // same two lines are the documented minimal config a project may well have committed itself.
      seed: { $schema: 'https://opencode.ai/config.json' },
      values: entries.map((entry) => ({ path: ['permission', entry.key, entry.pattern], value: entry.effect })),
    };
    const preview: Record<string, Record<string, string>> = {};
    for (const entry of entries) (preview[entry.key] ??= {})[entry.pattern] = entry.effect;
    files.push(desired(
      'opencode', version, 'opencode.json',
      `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: preview }, null, 2)}\n`,
      'permissions', input.policies.map((item) => item.yamlPath), fragment,
    ));
  }

  const hooks = enabledRuntimeHooks(input).filter((item) => RUNTIME_HOOK_EVENTS.opencode.includes(item.value.spec.event));
  if (hooks.length > 0 || input.policies.length > 0) {
    const before = input.policies.length > 0 || hooks.some((item) => ['agent.tool.before', 'agent.permission.request'].includes(item.value.spec.event));
    const after = hooks.some((item) => item.value.spec.event === 'agent.tool.after');
    const plugin = `import { spawn } from "node:child_process";\nimport { Plugin } from "@opencode-ai/plugin";\n\nasync function dispatch(event, phase) {\n  const output = await new Promise((resolve, reject) => {\n    const child = spawn("xforge", ["hook", "dispatch", "--target", "opencode", "--event", phase], { stdio: ["pipe", "pipe", "inherit"] });\n    const chunks = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.on("error", reject); child.on("close", code => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error("XForge hook dispatcher failed"))); child.stdin.end(JSON.stringify(event));\n  });\n  const decision = JSON.parse(output || "{}");\n  if (decision.decision === "deny") throw new Error(decision.reason || "Denied by XForge policy");\n}\n\nexport default Plugin.define({\n  id: "xforge.governance",\n  setup: async (ctx) => {\n${before ? '    await ctx.tool.hook("execute.before", event => dispatch(event, "agent.tool.before"));\n' : ''}${after ? '    await ctx.tool.hook("execute.after", event => dispatch(event, "agent.tool.after"));\n' : ''}  },\n});\n`;
    files.push(desired('opencode', version, '.opencode/plugins/xforge-governance.ts', plugin, 'hooks', [...input.policies.map((item) => item.yamlPath), ...hooks.map((item) => item.yamlPath)]));
  }
  return { files, diagnostics };
}

export function renderGovernance(target: TargetId, version: string, input: GovernanceProjectionInput): GovernanceProjection {
  if (target === 'claude') return renderClaude(input, version);
  if (target === 'codex') return renderCodex(input, version);
  if (target === 'cursor') return renderCursor(input, version);
  if (target === 'github-copilot') return renderCopilot(input, version);
  return renderOpenCode(input, version);
}
