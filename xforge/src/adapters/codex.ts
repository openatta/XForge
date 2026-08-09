import type { Adapter } from './types.js';
import { artifactTrace } from './shared.js';

export const codexAdapter: Adapter = {
  id: 'codex',
  version: '1',
  trace: artifactTrace('codex', '1'),
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
