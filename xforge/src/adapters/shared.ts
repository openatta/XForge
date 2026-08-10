import type { AgentResource, DesiredFile, RuleResource } from '../types.js';
import type { TargetId } from '../constants.js';
import { normalizeRule } from '../core/governance.js';

export function artifactTrace(target: TargetId, version: string) {
  return (kind: string, id: string, sourcePaths: string[]): Pick<DesiredFile, 'resource' | 'sourcePaths' | 'renderVersion'> => ({
    resource: { kind, id },
    sourcePaths,
    renderVersion: `${target}:${kind}:${version}`,
  });
}

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
  return `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${renderAgentBody(agent, instructions)}`;
}

export function renderAgentBody(agent: AgentResource, instructions: string): string {
  return `${instructions.trim()}\n\n## XForge capabilities\n\n- Skills: ${agent.spec.skills.join(', ') || 'none'}\n- Allowed tools: ${agent.spec.tools.allow.join(', ') || 'none'}\n- Model class: ${agent.spec.model.class}\n- Max concurrency: ${agent.spec.delegation.maxConcurrency}\n`;
}

export function renderCodexAgentToml(agent: AgentResource, instructions: string): string {
  const sandboxMode = agent.spec.tools.allow.some((tool) => ['write', 'edit'].includes(tool)) ? 'workspace-write' : 'read-only';
  const reasoningEffort = agent.spec.model.class === 'reasoning' ? 'high' : 'medium';
  return [
    `name = ${JSON.stringify(agent.metadata.name)}`,
    `description = ${JSON.stringify(agent.spec.role)}`,
    `sandbox_mode = ${JSON.stringify(sandboxMode)}`,
    `model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`,
    `developer_instructions = ${JSON.stringify(renderAgentBody(agent, instructions))}`,
    '',
  ].join('\n');
}

export function renderRuleMarkdown(rule: RuleResource, extra: Record<string, string> = {}): string {
  const normalized = normalizeRule(rule);
  const frontmatter = {
    description: `${rule.metadata.name} (${normalized.severity})`,
    ...extra,
  };
  return `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n# ${rule.metadata.name}\n\nSeverity: ${normalized.severity}\n\n${normalized.instruction.trim()}\n\nEnforcement: gates=${normalized.gateRefs.join(', ') || 'none'}; policies=${normalized.policyRefs.join(', ') || 'none'}; approvals=${normalized.approvalRefs.join(', ') || 'none'}.\n`;
}

export function rulePaths(rule: RuleResource): string[] {
  return normalizeRule(rule).paths;
}

export const BOOTSTRAP_BODY = `# XForge bootstrap\n\nBefore project work, read \`xforge/manifest.yaml\`, \`xforge/constitution.md\`, and the active Change under the resolved logical Changes path. Use installed \`xforge-*\` Skills and treat only matching CLI/Gate evidence as enforced facts.\n`;
