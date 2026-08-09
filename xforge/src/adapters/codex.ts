import type { Adapter } from './types.js';
import { artifactTrace } from './shared.js';
import { renderGovernance } from './governance.js';

export const codexAdapter: Adapter = {
  id: 'codex',
  version: '2',
  trace: artifactTrace('codex', '2'),
  capability: {
    skills: 'native', commands: 'unsupported', agents: 'unsupported', rules: 'degraded', hooks: 'native', guidance: 'degraded', permissionPolicy: 'degraded',
    runtimeHook: { events: ['agent.session.start', 'agent.session.end', 'agent.prompt.submit', 'agent.tool.before', 'agent.tool.after', 'agent.permission.request', 'agent.subagent.start', 'agent.subagent.stop', 'agent.turn.stop'], blocking: 'native', managed: 'native', local: 'native', cloud: 'unsupported', trust: 'platform-review', bypasses: ['hosted tools', 'specialized opt-out tool paths'] },
    auditDelivery: 'native', subagent: 'native',
  },
  skillDirectory: (id) => `.agents/skills/${id}`,
  commandPath: () => null,
  renderCommand: () => null,
  agentPath: () => null,
  renderAgent: () => null,
  rulePath: () => null,
  renderRule: () => null,
  renderGovernance: (input) => renderGovernance('codex', '2', input),
  bootstrap: () => [],
};
