import type { AgentResource, RuleResource } from '../types.js';

export function actionId(skillId: string): string {
  return skillId.startsWith('xforge-') ? skillId.slice('xforge-'.length) : skillId;
}

export function commandBody(skillId: string, frontmatter: Record<string, string> = {}): string {
  const header = Object.keys(frontmatter).length === 0
    ? ''
    : `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n`;
  return `${header}Use the \`${skillId}\` Skill for this request. Begin with \`xforge state\`${skillId === 'xforge-explore' ? '' : ' and resolve the Change ID'}, consume all Flow instructions dynamically, and distinguish Agent guidance from CLI/Gate evidence.\n`;
}

export function renderAgentMarkdown(agent: AgentResource, instructions: string, extra: Record<string, string> = {}): string {
  const frontmatter = {
    name: agent.metadata.name,
    description: agent.spec.role,
    ...extra,
  };
  return `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${instructions.trim()}\n\n## XForge capabilities\n\n- Skills: ${agent.spec.skills.join(', ') || 'none'}\n- Allowed tools: ${agent.spec.tools.allow.join(', ') || 'none'}\n- Model class: ${agent.spec.model.class}\n- Max concurrency: ${agent.spec.delegation.maxConcurrency}\n`;
}

export function renderRuleMarkdown(rule: RuleResource, extra: Record<string, string> = {}): string {
  const frontmatter = {
    description: `${rule.metadata.name} (${rule.spec.level})`,
    ...extra,
  };
  return `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n# ${rule.metadata.name}\n\nLevel: ${rule.spec.level}\n\n${rule.spec.instruction.trim()}\n`;
}

export const BOOTSTRAP_BODY = `# XForge bootstrap\n\nBefore project work, read \`xforge/manifest.yaml\`, \`xforge/constitution.md\`, and the active Change under the resolved logical Changes path. Use installed \`xforge-*\` Skills and treat only matching CLI/Gate evidence as enforced facts.\n`;
