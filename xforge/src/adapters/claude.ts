import type { Adapter } from './types.js';
import { BOOTSTRAP_BODY, actionId, artifactTrace, commandBody, renderAgentMarkdown, renderRuleMarkdown } from './shared.js';

export const claudeAdapter: Adapter = {
  id: 'claude',
  version: '1',
  trace: artifactTrace('claude', '1'),
  capability: { skills: 'native', commands: 'native', agents: 'native', rules: 'native', hooks: 'unsupported' },
  skillDirectory: (id) => `.claude/skills/${id}`,
  commandPath: (id) => `.claude/commands/xforge/${actionId(id)}.md`,
  renderCommand: (id) => commandBody(id, { description: `Invoke ${id}` }),
  agentPath: (id) => `.claude/agents/${id}.md`,
  renderAgent: (agent, instructions) => renderAgentMarkdown(agent, instructions),
  rulePath: (id) => `.claude/rules/${id}.md`,
  renderRule: (rule) => renderRuleMarkdown(rule),
  bootstrap: () => [{
    path: '.claude/rules/xforge-bootstrap.md', content: Buffer.from(BOOTSTRAP_BODY),
    source: 'builtin:bootstrap', target: 'claude',
    resource: { kind: 'builtin', id: 'bootstrap' }, sourcePaths: [], renderVersion: 'claude:builtin:1',
  }],
};
