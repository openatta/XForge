import type { Adapter } from './types.js';
import { artifactTrace, renderCodexAgentToml } from './shared.js';
import { PERMISSION_POLICY_SCOPES, RUNTIME_HOOK_EVENTS } from './capabilities.js';
import { renderGovernance } from './governance.js';

export const codexAdapter: Adapter = {
  id: 'codex',
  version: '3',
  trace: artifactTrace('codex', '3'),
  capability: {
    skills: 'native', commands: 'unsupported', agents: 'native', rules: 'degraded', hooks: 'native', guidance: 'degraded', permissionPolicy: 'degraded',
    runtimeHook: { events: RUNTIME_HOOK_EVENTS.codex, blocking: 'native', managed: 'native', local: 'native', cloud: 'unsupported', trust: 'platform-review', bypasses: ['hosted tools', 'specialized opt-out tool paths'] },
    auditDelivery: 'native', subagent: 'native',
    permissionPolicyScopes: PERMISSION_POLICY_SCOPES.codex,
  },
  skillDirectory: (id) => `.agents/skills/${id}`,
  commandPath: () => null,
  renderCommand: () => null,
  agentPath: (id) => `.codex/agents/${id}.toml`,
  renderAgent: (agent, instructions) => renderCodexAgentToml(agent, instructions),
  rulePath: () => null,
  renderRule: () => null,
  renderGovernance: (input) => renderGovernance('codex', '2', input),
  bootstrap: () => [],
};
