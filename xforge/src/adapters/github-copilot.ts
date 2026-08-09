import type { Adapter } from './types.js';
import { BOOTSTRAP_BODY, artifactTrace, commandBody, renderAgentMarkdown, renderRuleMarkdown } from './shared.js';

export const githubCopilotAdapter: Adapter = {
  id: 'github-copilot',
  version: '1',
  trace: artifactTrace('github-copilot', '1'),
  capability: { skills: 'native', commands: 'native', agents: 'native', rules: 'native', hooks: 'unsupported' },
  skillDirectory: (id) => `.github/skills/${id}`,
  commandPath: (id) => `.github/prompts/${id}.prompt.md`,
  renderCommand: (id) => commandBody(id, { mode: 'agent', description: `Invoke ${id}` }),
  agentPath: (id) => `.github/agents/${id}.agent.md`,
  renderAgent: (agent, instructions) => renderAgentMarkdown(agent, instructions),
  rulePath: (id) => `.github/instructions/${id}.instructions.md`,
  renderRule: (rule) => renderRuleMarkdown(rule, { applyTo: (rule.spec.paths ?? ['**']).join(',') }),
  bootstrap: () => [{
    path: '.github/instructions/xforge-bootstrap.instructions.md',
    content: Buffer.from(`---\napplyTo: "**"\ndescription: "XForge project bootstrap"\n---\n\n${BOOTSTRAP_BODY}`),
    source: 'builtin:bootstrap', target: 'github-copilot',
    resource: { kind: 'builtin', id: 'bootstrap' }, sourcePaths: [], renderVersion: 'github-copilot:builtin:1',
  }],
};
