import type { Adapter } from './types.js';
import {
  BOOTSTRAP_BODY,
  CLAUDE_MEMORY_BEGIN,
  CLAUDE_MEMORY_BODY,
  CLAUDE_MEMORY_END,
  actionId,
  artifactTrace,
  claudeAgentFrontmatter,
  commandBody,
  renderAgentMarkdown,
  renderRuleMarkdown,
  rulePaths,
} from './shared.js';
import { PERMISSION_POLICY_SCOPES, RUNTIME_HOOK_EVENTS } from './capabilities.js';
import { renderGovernance } from './governance.js';

export const claudeAdapter: Adapter = {
  id: 'claude',
  version: '3',
  trace: artifactTrace('claude', '3'),
  capability: {
    skills: 'native', commands: 'native', agents: 'native', rules: 'native', hooks: 'native', guidance: 'native', permissionPolicy: 'native',
    runtimeHook: { events: RUNTIME_HOOK_EVENTS.claude, blocking: 'native', managed: 'degraded', local: 'native', cloud: 'degraded', trust: 'platform-review', bypasses: ['disableAllHooks in any settings file', 'allowManagedHooksOnly in managed settings'] },
    auditDelivery: 'native', subagent: 'native',
    permissionPolicyScopes: PERMISSION_POLICY_SCOPES.claude,
  },
  skillDirectory: (id) => `.claude/skills/${id}`,
  commandPath: (id) => `.claude/commands/xforge/${actionId(id)}.md`,
  renderCommand: (id) => commandBody(id, { description: `Invoke ${id}` }),
  agentPath: (id) => `.claude/agents/${id}.md`,
  renderAgent: (agent, instructions) => renderAgentMarkdown(agent, instructions, claudeAgentFrontmatter(agent)),
  rulePath: (id) => `.claude/rules/${id}.md`,
  // `.claude/rules/*.md` scopes by a `paths:` YAML array; a rule without one loads into every
  // session unconditionally. `description` is not a key Claude rules recognise, so it is dropped.
  renderRule: (rule) => renderRuleMarkdown(rule, { paths: rulePaths(rule) }, { description: false }),
  renderGovernance: (input) => renderGovernance('claude', '3', input),
  bootstrap: () => [
    {
      path: '.claude/rules/xforge-bootstrap.md', content: Buffer.from(BOOTSTRAP_BODY),
      source: 'builtin:bootstrap', target: 'claude',
      resource: { kind: 'builtin', id: 'bootstrap' }, sourcePaths: [], renderVersion: 'claude:builtin:3',
    },
    {
      path: 'CLAUDE.md', content: Buffer.from(`${CLAUDE_MEMORY_BEGIN}\n${CLAUDE_MEMORY_BODY}\n${CLAUDE_MEMORY_END}\n`),
      source: 'builtin:claude-memory', target: 'claude',
      resource: { kind: 'builtin', id: 'claude-memory' }, sourcePaths: [], renderVersion: 'claude:builtin:3',
      fragment: { format: 'markers', begin: CLAUDE_MEMORY_BEGIN, end: CLAUDE_MEMORY_END, body: CLAUDE_MEMORY_BODY },
    },
  ],
};
