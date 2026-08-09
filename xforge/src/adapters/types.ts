import type {
  AdapterCapability,
  AgentResource,
  DesiredFile,
  RuleResource,
  HookResource,
  PermissionPolicyResource,
} from '../types.js';
import type { TargetId } from '../constants.js';

export interface Adapter {
  id: TargetId;
  version: string;
  capability: AdapterCapability;
  trace(kind: string, id: string, sourcePaths: string[]): Pick<DesiredFile, 'resource' | 'sourcePaths' | 'renderVersion'>;
  skillDirectory(skillId: string): string;
  commandPath(skillId: string): string | null;
  renderCommand(skillId: string): string | null;
  agentPath(agentId: string): string | null;
  renderAgent(agent: AgentResource, instructions: string): string | null;
  rulePath(ruleId: string): string | null;
  renderRule(rule: RuleResource): string | null;
  renderGovernance(input: GovernanceProjectionInput): DesiredFile[];
  bootstrap(): DesiredFile[];
}

export interface GovernanceProjectionInput {
  policies: Array<{ id: string; value: PermissionPolicyResource; yamlPath: string }>;
  hooks: Array<{ id: string; value: HookResource; yamlPath: string }>;
}
