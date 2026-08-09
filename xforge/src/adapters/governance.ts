import type { TargetId } from '../constants.js';
import type { DesiredFile, HookResource, PermissionPolicyResource } from '../types.js';
import type { GovernanceProjectionInput } from './types.js';

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
  cursor: {
    'agent.session.start': 'sessionStart', 'agent.session.end': 'sessionEnd', 'agent.prompt.submit': 'beforeSubmitPrompt',
    'agent.tool.before': 'preToolUse', 'agent.tool.after': 'postToolUse', 'agent.permission.request': 'preToolUse',
    'agent.subagent.start': 'subagentStart', 'agent.subagent.stop': 'subagentStop', 'agent.turn.stop': 'stop',
  },
  'github-copilot': {
    'agent.session.start': 'sessionStart', 'agent.session.end': 'sessionEnd', 'agent.prompt.submit': 'userPromptSubmitted',
    'agent.tool.before': 'preToolUse', 'agent.tool.after': 'postToolUse', 'agent.permission.request': 'permissionRequest',
    'agent.subagent.start': 'subagentStart', 'agent.subagent.stop': 'subagentStop', 'agent.turn.stop': 'agentStop',
  },
  opencode: {},
};

function dispatcher(target: TargetId, event: string): string {
  return `npx --no-install xforge hook dispatch --target ${target} --event ${event}`;
}

function desired(target: TargetId, version: string, path: string, content: string, id: string, sources: string[]): DesiredFile {
  return {
    path, content: Buffer.from(content), source: `governance:${id}`, target,
    resource: { kind: 'governance', id }, sourcePaths: sources, renderVersion: `${target}:governance:${version}`,
  };
}

function enabledRuntimeHooks(input: GovernanceProjectionInput): Array<{ id: string; value: HookResource; yamlPath: string }> {
  return input.hooks.filter((item) => item.value.spec.enabled && (item.value.spec.plane ?? 'runtime') === 'runtime');
}

function hookEntries(target: TargetId, input: GovernanceProjectionInput, format: 'grouped' | 'cursor' | 'copilot'): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const hook of enabledRuntimeHooks(input)) {
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

function claudePermissionRule(policy: PermissionPolicyResource): string[] {
  const match = policy.spec.match;
  if (policy.spec.capability === 'fs.read') return (match.paths ?? ['**']).map((value) => `Read(${value})`);
  if (policy.spec.capability === 'fs.write') return (match.paths ?? ['**']).flatMap((value) => [`Edit(${value})`, `Write(${value})`]);
  if (policy.spec.capability === 'shell') return (match.commands ?? ['*']).map((value) => `Bash(${value})`);
  if (policy.spec.capability === 'network') return (match.hosts ?? ['*']).map((value) => `WebFetch(domain:${value})`);
  if (policy.spec.capability === 'subagent') return (match.tools ?? ['*']).map((value) => `Agent(${value})`);
  if (policy.spec.capability === 'mcp') return (match.mcpServers ?? ['*']).map((value) => `mcp__${value}__*`);
  return [];
}

function renderClaude(input: GovernanceProjectionInput, version: string): DesiredFile[] {
  const permissions: Record<'allow' | 'ask' | 'deny', string[]> = { allow: [], ask: [], deny: [] };
  for (const policy of input.policies) permissions[policy.value.spec.effect].push(...claudePermissionRule(policy.value));
  const hooks = hookEntries('claude', input, 'grouped');
  if (input.policies.length > 0) {
    (hooks.PreToolUse ??= []).unshift({ matcher: '*', hooks: [{ type: 'command', command: dispatcher('claude', 'agent.tool.before'), timeout: 10 }] });
  }
  if (Object.values(permissions).every((items) => items.length === 0) && Object.keys(hooks).length === 0) return [];
  const body = {
    permissions: Object.fromEntries(Object.entries(permissions).filter(([, value]) => value.length > 0).map(([key, value]) => [key, [...new Set(value)].sort()])),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
  };
  return [desired('claude', version, '.claude/settings.json', `${JSON.stringify(body, null, 2)}\n`, 'settings', [...input.policies.map((item) => item.yamlPath), ...enabledRuntimeHooks(input).map((item) => item.yamlPath)])];
}

function codexRule(policy: PermissionPolicyResource): string | null {
  if (policy.spec.capability !== 'shell' || !(policy.spec.match.commands?.length)) return null;
  const decision = { allow: 'allow', ask: 'prompt', deny: 'forbidden' }[policy.spec.effect];
  return `${policy.spec.match.commands.map((command) => {
    const pattern = command.trim().split(/\s+/).filter((token) => token !== '*').map((token) => JSON.stringify(token));
    return `prefix_rule(\n  pattern = [${pattern.join(', ')}],\n  decision = ${JSON.stringify(decision)},\n  justification = ${JSON.stringify(policy.spec.reason)},\n)`;
  }).join('\n\n')}\n`;
}

function renderCodex(input: GovernanceProjectionInput, version: string): DesiredFile[] {
  const files: DesiredFile[] = [];
  for (const policy of input.policies) {
    const content = codexRule(policy.value);
    if (content) files.push(desired('codex', version, `.codex/rules/xforge-${policy.id}.rules`, content, `permission-${policy.id}`, [policy.yamlPath]));
  }
  const hooks = hookEntries('codex', input, 'grouped');
  if (input.policies.some((item) => item.value.spec.capability !== 'shell')) {
    (hooks.PreToolUse ??= []).unshift({ matcher: '*', hooks: [{ type: 'command', command: dispatcher('codex', 'agent.tool.before'), timeout: 10, statusMessage: 'Evaluating XForge policy' }] });
  }
  if (Object.keys(hooks).length > 0) files.push(desired('codex', version, '.codex/hooks.json', `${JSON.stringify({ description: 'XForge runtime governance bridge. Review and trust this exact definition in Codex.', hooks }, null, 2)}\n`, 'hooks', [...input.policies.map((item) => item.yamlPath), ...enabledRuntimeHooks(input).map((item) => item.yamlPath)]));
  return files;
}

function renderCursor(input: GovernanceProjectionInput, version: string): DesiredFile[] {
  const hooks = hookEntries('cursor', input, 'cursor');
  if (input.policies.length > 0) (hooks.preToolUse ??= []).unshift({ command: dispatcher('cursor', 'agent.tool.before'), timeout: 10, matcher: 'Shell|Read|Write|Delete|Task|MCP:.*' });
  if (Object.keys(hooks).length === 0) return [];
  return [desired('cursor', version, '.cursor/hooks.json', `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, 'hooks', [...input.policies.map((item) => item.yamlPath), ...enabledRuntimeHooks(input).map((item) => item.yamlPath)])];
}

function renderCopilot(input: GovernanceProjectionInput, version: string): DesiredFile[] {
  const hooks = hookEntries('github-copilot', input, 'copilot');
  if (input.policies.length > 0) (hooks.preToolUse ??= []).unshift({ type: 'command', command: dispatcher('github-copilot', 'agent.tool.before'), bash: dispatcher('github-copilot', 'agent.tool.before'), cwd: '.', timeoutSec: 10 });
  if (Object.keys(hooks).length === 0) return [];
  return [desired('github-copilot', version, '.github/hooks/xforge.json', `${JSON.stringify({ version: 1, disableAllHooks: false, hooks }, null, 2)}\n`, 'hooks', [...input.policies.map((item) => item.yamlPath), ...enabledRuntimeHooks(input).map((item) => item.yamlPath)])];
}

function openCodeActions(policy: PermissionPolicyResource): Array<{ action: string; resource: string; effect: string }> {
  const actions: Record<PermissionPolicyResource['spec']['capability'], string> = {
    'fs.read': 'read', 'fs.write': 'edit', shell: 'shell', network: 'webfetch', mcp: 'mcp', subagent: 'subagent', 'external.write': 'execute',
  };
  const match = policy.spec.match;
  const resources = policy.spec.capability === 'shell' ? match.commands : policy.spec.capability === 'network' ? match.hosts :
    policy.spec.capability === 'mcp' ? match.mcpServers : policy.spec.capability === 'subagent' ? match.tools : match.paths;
  return (resources ?? ['*']).map((resource) => ({
    action: policy.spec.capability === 'mcp' ? `${resource}_*` : actions[policy.spec.capability],
    resource: policy.spec.capability === 'mcp' ? '*' : resource,
    effect: policy.spec.effect,
  }));
}

function renderOpenCode(input: GovernanceProjectionInput, version: string): DesiredFile[] {
  const files: DesiredFile[] = [];
  if (input.policies.length > 0) {
    const weight = { allow: 0, ask: 1, deny: 2 };
    const permissions = input.policies.flatMap((item) => openCodeActions(item.value)).sort((left, right) => weight[left.effect as keyof typeof weight] - weight[right.effect as keyof typeof weight]);
    files.push(desired('opencode', version, 'opencode.json', `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', permissions }, null, 2)}\n`, 'permissions', input.policies.map((item) => item.yamlPath)));
  }
  const hooks = enabledRuntimeHooks(input);
  if (hooks.length > 0 || input.policies.length > 0) {
    const before = input.policies.length > 0 || hooks.some((item) => ['agent.tool.before', 'agent.permission.request'].includes(item.value.spec.event));
    const after = hooks.some((item) => item.value.spec.event === 'agent.tool.after');
    const plugin = `import { spawn } from "node:child_process";\nimport { Plugin } from "@opencode-ai/plugin";\n\nasync function dispatch(event, phase) {\n  const output = await new Promise((resolve, reject) => {\n    const child = spawn("npx", ["--no-install", "xforge", "hook", "dispatch", "--target", "opencode", "--event", phase], { stdio: ["pipe", "pipe", "inherit"] });\n    const chunks = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.on("error", reject); child.on("close", code => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error("XForge hook dispatcher failed"))); child.stdin.end(JSON.stringify(event));\n  });\n  const decision = JSON.parse(output || "{}");\n  if (decision.decision === "deny") throw new Error(decision.reason || "Denied by XForge policy");\n}\n\nexport default Plugin.define({\n  id: "xforge.governance",\n  setup: async (ctx) => {\n${before ? '    await ctx.tool.hook("execute.before", event => dispatch(event, "agent.tool.before"));\n' : ''}${after ? '    await ctx.tool.hook("execute.after", event => dispatch(event, "agent.tool.after"));\n' : ''}  },\n});\n`;
    files.push(desired('opencode', version, '.opencode/plugins/xforge-governance.ts', plugin, 'hooks', [...input.policies.map((item) => item.yamlPath), ...hooks.map((item) => item.yamlPath)]));
  }
  return files;
}

export function renderGovernance(target: TargetId, version: string, input: GovernanceProjectionInput): DesiredFile[] {
  if (target === 'claude') return renderClaude(input, version);
  if (target === 'codex') return renderCodex(input, version);
  if (target === 'cursor') return renderCursor(input, version);
  if (target === 'github-copilot') return renderCopilot(input, version);
  return renderOpenCode(input, version);
}
