import type { Adapter } from './types.js';
import { commandBody, renderAgentMarkdown } from './shared.js';

export const opencodeAdapter: Adapter = {
  id: 'opencode',
  capability: { skills: 'native', commands: 'native', agents: 'native', rules: 'degraded', hooks: 'unsupported' },
  skillDirectory: (id) => `.opencode/skills/${id}`,
  commandPath: (id) => `.opencode/commands/${id}.md`,
  renderCommand: (id) => commandBody(id, { description: `Invoke ${id}` }),
  agentPath: (id) => `.opencode/agents/${id}.md`,
  renderAgent: (agent, instructions) => renderAgentMarkdown(agent, instructions),
  rulePath: () => null,
  renderRule: () => null,
  bootstrap: () => [],
};
