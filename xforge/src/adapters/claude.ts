import type { Adapter } from './types.js';
import { BOOTSTRAP_BODY, actionId, artifactTrace, commandBody, renderAgentMarkdown, renderRuleMarkdown } from './shared.js';
import { renderGovernance } from './governance.js';

export const claudeAdapter: Adapter = {
  id: 'claude',
  version: '2',
  trace: artifactTrace('claude', '2'),
  capability: {
    skills: 'native', commands: 'native', agents: 'native', rules: 'native', hooks: 'native', guidance: 'native', permissionPolicy: 'native',
    runtimeHook: { events: ['agent.session.start', 'agent.session.end', 'agent.prompt.submit', 'agent.tool.before', 'agent.tool.after', 'agent.permission.request', 'agent.subagent.start', 'agent.subagent.stop', 'agent.turn.stop'], blocking: 'native', managed: 'degraded', local: 'native', cloud: 'degraded', trust: 'platform-review', bypasses: [] },
    auditDelivery: 'native', subagent: 'native',
  },
  skillDirectory: (id) => `.claude/skills/${id}`,
  commandPath: (id) => `.claude/commands/xforge/${actionId(id)}.md`,
  renderCommand: (id) => commandBody(id, { description: `Invoke ${id}` }),
  agentPath: (id) => `.claude/agents/${id}.md`,
  renderAgent: (agent, instructions) => renderAgentMarkdown(agent, instructions),
  rulePath: (id) => `.claude/rules/${id}.md`,
  renderRule: (rule) => renderRuleMarkdown(rule),
  renderGovernance: (input) => renderGovernance('claude', '2', input),
  bootstrap: () => [{
    path: '.claude/rules/xforge-bootstrap.md', content: Buffer.from(BOOTSTRAP_BODY),
    source: 'builtin:bootstrap', target: 'claude',
    resource: { kind: 'builtin', id: 'bootstrap' }, sourcePaths: [], renderVersion: 'claude:builtin:2',
  }],
};
