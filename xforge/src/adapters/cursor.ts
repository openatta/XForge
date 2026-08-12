import type { Adapter } from './types.js';
import { BOOTSTRAP_BODY, artifactTrace, commandBody, cursorAgentFrontmatter, renderAgentMarkdown, renderRuleMarkdown, rulePaths } from './shared.js';
import { PERMISSION_POLICY_SCOPES, RUNTIME_HOOK_EVENTS } from './capabilities.js';
import { renderGovernance } from './governance.js';

export const cursorAdapter: Adapter = {
  id: 'cursor',
  version: '3',
  trace: artifactTrace('cursor', '3'),
  capability: {
    skills: 'native', commands: 'native', agents: 'native', rules: 'native', hooks: 'native', guidance: 'native', permissionPolicy: 'degraded',
    runtimeHook: { events: RUNTIME_HOOK_EVENTS.cursor, blocking: 'native', managed: 'native', local: 'native', cloud: 'native', trust: 'platform-review', bypasses: ['events not exposed by Cursor'] },
    auditDelivery: 'native', subagent: 'degraded',
    permissionPolicyScopes: PERMISSION_POLICY_SCOPES.cursor,
  },
  skillDirectory: (id) => `.cursor/skills/${id}`,
  commandPath: (id) => `.cursor/commands/${id}.md`,
  renderCommand: (id) => commandBody(id),
  agentPath: (id) => `.cursor/agents/${id}.md`,
  renderAgent: (agent, instructions) => renderAgentMarkdown(agent, instructions, cursorAgentFrontmatter(agent)),
  rulePath: (id) => `.cursor/rules/${id}.mdc`,
  renderRule: (rule) => renderRuleMarkdown(rule, { globs: (rulePaths(rule).length ? rulePaths(rule) : ['**/*']).join(',') }),
  renderGovernance: (input) => renderGovernance('cursor', '2', input),
  bootstrap: () => [{
    path: '.cursor/rules/xforge-bootstrap.mdc', content: Buffer.from(`---\ndescription: "XForge project bootstrap"\nalwaysApply: true\n---\n\n${BOOTSTRAP_BODY}`),
    source: 'builtin:bootstrap', target: 'cursor',
    resource: { kind: 'builtin', id: 'bootstrap' }, sourcePaths: [], renderVersion: 'cursor:builtin:3',
  }],
};
