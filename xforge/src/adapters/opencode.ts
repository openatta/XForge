import type { Adapter } from './types.js';
import { artifactTrace, commandBody, renderAgentMarkdown } from './shared.js';
import { renderGovernance } from './governance.js';

export const opencodeAdapter: Adapter = {
  id: 'opencode',
  version: '2',
  trace: artifactTrace('opencode', '2'),
  capability: {
    skills: 'native', commands: 'native', agents: 'native', rules: 'degraded', hooks: 'native', guidance: 'degraded', permissionPolicy: 'native',
    runtimeHook: { events: ['agent.session.start', 'agent.session.end', 'agent.tool.before', 'agent.tool.after', 'agent.permission.request', 'agent.turn.stop'], blocking: 'degraded', managed: 'degraded', local: 'native', cloud: 'degraded', trust: 'none', bypasses: ['events not emitted by the plugin API'] },
    auditDelivery: 'native', subagent: 'native',
  },
  skillDirectory: (id) => `.opencode/skills/${id}`,
  commandPath: (id) => `.opencode/commands/${id}.md`,
  renderCommand: (id) => commandBody(id, { description: `Invoke ${id}` }),
  agentPath: (id) => `.opencode/agents/${id}.md`,
  renderAgent: (agent, instructions) => renderAgentMarkdown(agent, instructions),
  rulePath: () => null,
  renderRule: () => null,
  renderGovernance: (input) => renderGovernance('opencode', '2', input),
  bootstrap: () => [],
};
