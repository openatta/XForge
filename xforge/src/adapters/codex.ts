import type { Adapter } from './types.js';

export const codexAdapter: Adapter = {
  id: 'codex',
  capability: { skills: 'native', commands: 'unsupported', agents: 'unsupported', rules: 'degraded', hooks: 'unsupported' },
  skillDirectory: (id) => `.agents/skills/${id}`,
  commandPath: () => null,
  renderCommand: () => null,
  agentPath: () => null,
  renderAgent: () => null,
  rulePath: () => null,
  renderRule: () => null,
  bootstrap: () => [],
};
