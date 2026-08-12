import type { Adapter } from './types.js';
import { artifactTrace, commandBody, opencodeAgentFrontmatter, renderAgentMarkdown } from './shared.js';
import { PERMISSION_POLICY_SCOPES, RUNTIME_HOOK_EVENTS } from './capabilities.js';
import { renderGovernance } from './governance.js';

export const opencodeAdapter: Adapter = {
  id: 'opencode',
  version: '3',
  trace: artifactTrace('opencode', '3'),
  capability: {
    skills: 'native', commands: 'native', agents: 'native', rules: 'degraded', hooks: 'native', guidance: 'degraded',
    // Downgraded from `native`: OpenCode's `permission` object is keyed by tool name and matches on
    // tool input only. It has no representation for `mcp` policies, for `exceptActors`, or for
    // stage scoping, so the layer is real but lossy.
    permissionPolicy: 'degraded',
    runtimeHook: { events: RUNTIME_HOOK_EVENTS.opencode, blocking: 'degraded', managed: 'degraded', local: 'native', cloud: 'degraded', trust: 'none', bypasses: ['events not emitted by the plugin API'] },
    auditDelivery: 'native', subagent: 'native',
    permissionPolicyScopes: PERMISSION_POLICY_SCOPES.opencode,
  },
  skillDirectory: (id) => `.opencode/skills/${id}`,
  commandPath: (id) => `.opencode/commands/${id}.md`,
  renderCommand: (id) => commandBody(id, { description: `Invoke ${id}` }),
  agentPath: (id) => `.opencode/agents/${id}.md`,
  renderAgent: (agent, instructions) => renderAgentMarkdown(agent, instructions, opencodeAgentFrontmatter(agent)),
  rulePath: () => null,
  renderRule: () => null,
  renderGovernance: (input) => renderGovernance('opencode', '3', input),
  bootstrap: () => [],
};
