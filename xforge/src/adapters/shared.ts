import type { AgentResource, DesiredFile, RuleResource } from '../types.js';
import type { TargetId } from '../constants.js';
import { normalizeRule } from '../core/governance.js';

export function artifactTrace(target: TargetId, version: string) {
  return (kind: string, id: string, sourcePaths: string[]): Pick<DesiredFile, 'resource' | 'sourcePaths' | 'renderVersion'> => ({
    resource: { kind, id },
    sourcePaths,
    renderVersion: `${target}:${kind}:${version}`,
  });
}

export function actionId(skillId: string): string {
  return skillId.startsWith('xforge-') ? skillId.slice('xforge-'.length) : skillId;
}

export type FrontmatterValue = string | number | boolean | string[] | Record<string, string> | undefined;

/**
 * Frontmatter used to be a `Record<string, string>` serialized with `JSON.stringify`, which made
 * every enforceable field — Claude's `paths:` array, Copilot's `tools:` list, OpenCode's
 * `permission:` map — impossible to express. Values are now rendered in their real YAML shape and
 * empty values are dropped rather than emitted as `""`.
 */
export function renderFrontmatter(fields: Record<string, FrontmatterValue>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`, ...value.map((item) => `  - ${JSON.stringify(item)}`));
    } else if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) continue;
      lines.push(`${key}:`, ...entries.map(([name, item]) => `  ${name}: ${JSON.stringify(item)}`));
    } else if (typeof value === 'string') {
      if (value === '') continue;
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n\n`;
}

export function commandBody(skillId: string, frontmatter: Record<string, FrontmatterValue> = {}): string {
  const header = Object.keys(frontmatter).length === 0 ? '' : renderFrontmatter(frontmatter);
  return `${header}Use the \`${skillId}\` Skill for this request. Begin with \`xforge state\`${skillId === 'xforge-explore' ? '' : ' and resolve the Change ID'}, consume all Flow instructions dynamically, and distinguish Agent guidance from CLI/Gate evidence.\n`;
}

/**
 * `spec.tools.allow` is the canonical, host-neutral capability set. Every target below enforces
 * tool access through frontmatter; previously only Codex read it and the other four rendered it as
 * a bullet list in the prose body, which left "Reviewer is read-only" as an unenforced slogan.
 */
export function agentAllows(agent: AgentResource, capability: 'read' | 'search' | 'write' | 'test' | 'network'): boolean {
  return agent.spec.tools.allow.includes(capability);
}

/** Claude Code subagent `tools:` is a comma-separated list of canonical tool names. */
export function claudeAgentFrontmatter(agent: AgentResource): Record<string, FrontmatterValue> {
  const tools = [
    ...(agentAllows(agent, 'read') ? ['Read'] : []),
    ...(agentAllows(agent, 'search') ? ['Grep', 'Glob'] : []),
    ...(agentAllows(agent, 'write') ? ['Write', 'Edit', 'NotebookEdit'] : []),
    ...(agentAllows(agent, 'test') ? ['Bash'] : []),
    ...(agentAllows(agent, 'network') ? ['WebFetch', 'WebSearch'] : []),
    'TodoWrite',
  ];
  const model = { reasoning: 'opus', fast: 'haiku' }[agent.spec.model.class] ?? 'inherit';
  return { tools: tools.join(', '), model };
}

/**
 * Cursor subagents have no `tools` frontmatter — tools are inherited from the parent agent and the
 * documented write constraint is the `readonly` boolean, so that is what the contract maps onto.
 */
export function cursorAgentFrontmatter(agent: AgentResource): Record<string, FrontmatterValue> {
  return { readonly: !agentAllows(agent, 'write') };
}

/** GitHub Copilot custom agents take a `tools:` list of documented aliases. */
export function copilotAgentFrontmatter(agent: AgentResource): Record<string, FrontmatterValue> {
  return {
    tools: [
      ...(agentAllows(agent, 'read') ? ['read'] : []),
      ...(agentAllows(agent, 'search') ? ['search'] : []),
      ...(agentAllows(agent, 'write') ? ['edit'] : []),
      ...(agentAllows(agent, 'test') ? ['execute'] : []),
      ...(agentAllows(agent, 'network') ? ['web'] : []),
      'todo',
    ],
  };
}

/**
 * OpenCode agents enforce access through a `permission:` map keyed by tool name, so a capability
 * the contract withholds becomes an explicit `deny` rather than an unstated default.
 */
export function opencodeAgentFrontmatter(agent: AgentResource): Record<string, FrontmatterValue> {
  const permission: Record<string, string> = {};
  if (!agentAllows(agent, 'read')) permission.read = 'deny';
  if (!agentAllows(agent, 'search')) { permission.glob = 'deny'; permission.grep = 'deny'; }
  if (!agentAllows(agent, 'write')) permission.edit = 'deny';
  if (!agentAllows(agent, 'test')) permission.bash = 'deny';
  if (!agentAllows(agent, 'network')) { permission.webfetch = 'deny'; permission.websearch = 'deny'; }
  return { mode: 'subagent', permission };
}

export function renderAgentMarkdown(agent: AgentResource, instructions: string, extra: Record<string, FrontmatterValue> = {}): string {
  return `${renderFrontmatter({ name: agent.metadata.name, description: agent.spec.role, ...extra })}${renderAgentBody(agent, instructions)}`;
}

export function renderAgentBody(agent: AgentResource, instructions: string): string {
  return `${instructions.trim()}\n\n## XForge capabilities\n\n- Skills: ${agent.spec.skills.join(', ') || 'none'}\n- Allowed tools: ${agent.spec.tools.allow.join(', ') || 'none'}\n- Model class: ${agent.spec.model.class}\n- Max concurrency: ${agent.spec.delegation.maxConcurrency}\n`;
}

export function renderCodexAgentToml(agent: AgentResource, instructions: string): string {
  const sandboxMode = agent.spec.tools.allow.some((tool) => ['write', 'edit'].includes(tool)) ? 'workspace-write' : 'read-only';
  const reasoningEffort = agent.spec.model.class === 'reasoning' ? 'high' : 'medium';
  return [
    `name = ${JSON.stringify(agent.metadata.name)}`,
    `description = ${JSON.stringify(agent.spec.role)}`,
    `sandbox_mode = ${JSON.stringify(sandboxMode)}`,
    `model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`,
    `developer_instructions = ${JSON.stringify(renderAgentBody(agent, instructions))}`,
    '',
  ].join('\n');
}

export function renderRuleMarkdown(
  rule: RuleResource,
  extra: Record<string, FrontmatterValue> = {},
  options: { description?: boolean } = {},
): string {
  const normalized = normalizeRule(rule);
  const frontmatter: Record<string, FrontmatterValue> = {
    ...(options.description === false ? {} : { description: `${rule.metadata.name} (${normalized.severity})` }),
    ...extra,
  };
  return `${renderFrontmatter(frontmatter)}# ${rule.metadata.name}\n\nSeverity: ${normalized.severity}\n\n${normalized.instruction.trim()}\n\nEnforcement: gates=${normalized.gateRefs.join(', ') || 'none'}; policies=${normalized.policyRefs.join(', ') || 'none'}; approvals=${normalized.approvalRefs.join(', ') || 'none'}.\n`;
}

export function rulePaths(rule: RuleResource): string[] {
  return normalizeRule(rule).paths;
}

export const BOOTSTRAP_BODY = `# XForge bootstrap\n\nBefore project work, read \`xforge/XFORGE.md\`, then \`xforge/manifest.yaml\`, \`xforge/constitution.md\`, and the active Change under the resolved logical Changes path. Use installed \`xforge-*\` Skills and treat only matching CLI/Gate evidence as enforced facts.\n`;

/**
 * Claude Code loads `CLAUDE.md`, never `AGENTS.md`, so its block used to import `AGENTS.md` to
 * avoid forking the text. Both now point at `xforge/XFORGE.md` instead, which removes a dependency
 * that only held by accident: a project using Claude alone need not have an `AGENTS.md` at all, and
 * that import was dangling whenever it did not.
 *
 * A plain path, not an `@` import: `@file` is Claude-specific, and the same sentence has to work in
 * `AGENTS.md`, which Codex, Cursor and Copilot read literally.
 */
export const CLAUDE_MEMORY_BEGIN = '<!-- XFORGE:BEGIN -->';
export const CLAUDE_MEMORY_END = '<!-- XFORGE:END -->';
export const CLAUDE_MEMORY_BODY = [
  '## XForge',
  '',
  'Before project work, read `xforge/XFORGE.md`. It carries the project bootstrap,',
  'the CLI invocation contract, and the spec-driven parallel development policy.',
  '',
  'Per-topic XForge guidance is installed under `.claude/rules/`.',
].join('\n');
