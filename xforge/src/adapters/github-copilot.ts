import type { Adapter } from './types.js';
import { BOOTSTRAP_BODY, artifactTrace, commandBody, copilotAgentFrontmatter, renderAgentMarkdown, renderRuleMarkdown, rulePaths } from './shared.js';
import { PERMISSION_POLICY_SCOPES, RUNTIME_HOOK_EVENTS } from './capabilities.js';
import { renderGovernance } from './governance.js';

export const githubCopilotAdapter: Adapter = {
  id: 'github-copilot',
  version: '3',
  trace: artifactTrace('github-copilot', '3'),
  capability: {
    skills: 'native', commands: 'native', agents: 'native', rules: 'native', hooks: 'native', guidance: 'native', permissionPolicy: 'degraded',
    runtimeHook: { events: RUNTIME_HOOK_EVENTS['github-copilot'], blocking: 'degraded', managed: 'degraded', local: 'native', cloud: 'degraded', trust: 'platform-review', bypasses: ['events not exposed by Copilot hooks'] },
    auditDelivery: 'native', subagent: 'degraded',
    permissionPolicyScopes: PERMISSION_POLICY_SCOPES['github-copilot'],
  },
  skillDirectory: (id) => `.github/skills/${id}`,
  commandPath: (id) => `.github/prompts/${id}.prompt.md`,
  renderCommand: (id) => commandBody(id, { mode: 'agent', description: `Invoke ${id}` }),
  agentPath: (id) => `.github/agents/${id}.agent.md`,
  renderAgent: (agent, instructions) => renderAgentMarkdown(agent, instructions, copilotAgentFrontmatter(agent)),
  rulePath: (id) => `.github/instructions/${id}.instructions.md`,
  renderRule: (rule) => renderRuleMarkdown(rule, { applyTo: (rulePaths(rule).length ? rulePaths(rule) : ['**']).join(',') }),
  renderGovernance: (input) => renderGovernance('github-copilot', '2', input),
  bootstrap: () => [{
    path: '.github/instructions/xforge-bootstrap.instructions.md',
    content: Buffer.from(`---\napplyTo: "**"\ndescription: "XForge project bootstrap"\n---\n\n${BOOTSTRAP_BODY}`),
    source: 'builtin:bootstrap', target: 'github-copilot',
    resource: { kind: 'builtin', id: 'bootstrap' }, sourcePaths: [], renderVersion: 'github-copilot:builtin:3',
  }],
};
