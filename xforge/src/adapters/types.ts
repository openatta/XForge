import type {
  AdapterCapability,
  AgentResource,
  DesiredFile,
  RuleResource,
} from '../types.js';
import type { TargetId } from '../constants.js';

export interface Adapter {
  id: TargetId;
  capability: AdapterCapability;
  skillDirectory(skillId: string): string;
  commandPath(skillId: string): string | null;
  renderCommand(skillId: string): string | null;
  agentPath(agentId: string): string | null;
  renderAgent(agent: AgentResource, instructions: string): string | null;
  rulePath(ruleId: string): string | null;
  renderRule(rule: RuleResource): string | null;
  bootstrap(): DesiredFile[];
}
