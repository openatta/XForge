import type { Adapter } from './types.js';
import { BOOTSTRAP_BODY, commandBody, renderAgentMarkdown, renderRuleMarkdown } from './shared.js';

export const cursorAdapter: Adapter = {
  id: 'cursor',
  capability: { skills: 'native', commands: 'native', agents: 'native', rules: 'native', hooks: 'unsupported' },
  skillDirectory: (id) => `.cursor/skills/${id}`,
  commandPath: (id) => `.cursor/commands/${id}.md`,
  renderCommand: (id) => commandBody(id),
  agentPath: (id) => `.cursor/agents/${id}.md`,
  renderAgent: (agent, instructions) => renderAgentMarkdown(agent, instructions),
  rulePath: (id) => `.cursor/rules/${id}.mdc`,
  renderRule: (rule) => renderRuleMarkdown(rule, { globs: (rule.spec.paths ?? ['**/*']).join(',') }),
  bootstrap: () => [{
    path: '.cursor/rules/xforge-bootstrap.mdc', content: Buffer.from(`---\ndescription: "XForge project bootstrap"\nalwaysApply: true\n---\n\n${BOOTSTRAP_BODY}`),
    source: 'builtin:bootstrap', target: 'cursor',
  }],
};
