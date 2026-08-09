import type { ChangeConfig, PermissionPolicyResource, RuleResource } from '../types.js';

export interface NormalizedRule {
  id: string;
  severity: 'must' | 'should';
  instruction: string;
  modules: string[];
  paths: string[];
  stages: string[];
  gateRefs: string[];
  policyRefs: string[];
  approvalRefs: string[];
  constitutionCompatibility: 'compatible' | 'conflict';
  legacyWritePolicy: 'integrator-only' | null;
}

export function normalizeRule(rule: RuleResource): NormalizedRule {
  const legacy = rule.apiVersion === 'xforge.dev/v1alpha1';
  return {
    id: rule.metadata.name,
    severity: rule.spec.severity ?? (rule.spec.level === 'advisory' ? 'should' : 'must'),
    instruction: rule.spec.instruction,
    modules: rule.spec.scope?.modules ?? rule.spec.modules ?? [],
    paths: rule.spec.scope?.paths ?? rule.spec.paths ?? [],
    stages: rule.spec.scope?.stages ?? [],
    gateRefs: rule.spec.enforcement?.gateRefs ?? (rule.spec.gate ? [rule.spec.gate] : []),
    policyRefs: rule.spec.enforcement?.policyRefs ?? [],
    approvalRefs: rule.spec.enforcement?.approvalRefs ?? [],
    constitutionCompatibility: rule.spec.constitutionCompatibility ?? 'compatible',
    legacyWritePolicy: legacy && rule.spec.writePolicy === 'integrator-only' ? 'integrator-only' : null,
  };
}

export function ruleApplies(rule: NormalizedRule, config: ChangeConfig, stage?: string): boolean {
  if (rule.modules.length > 0 && !rule.modules.some((module) => config.scope.modules.includes(module))) return false;
  if (rule.stages.length > 0 && stage && !rule.stages.includes(stage)) return false;
  if (rule.paths.length > 0 && !rule.paths.some((rulePath) => config.scope.paths.some((scopePath) => {
    const ruleRoot = rulePath.replace(/\/\*\*.*$/, '');
    const scopeRoot = scopePath.replace(/\/\*\*.*$/, '');
    return ruleRoot === scopeRoot || ruleRoot.startsWith(`${scopeRoot}/`) || scopeRoot.startsWith(`${ruleRoot}/`);
  }))) return false;
  return true;
}

export function policyApplies(policy: PermissionPolicyResource, config: ChangeConfig, stage?: string): boolean {
  const stages = policy.spec.match.stages ?? [];
  if (stages.length > 0 && stage && !stages.includes(stage)) return false;
  const paths = policy.spec.match.paths ?? [];
  if (paths.length === 0) return true;
  return paths.some((policyPath) => config.scope.paths.some((scopePath) => {
    const policyRoot = policyPath.replace(/\/\*\*.*$/, '');
    const scopeRoot = scopePath.replace(/\/\*\*.*$/, '');
    return policyRoot === scopeRoot || policyRoot.startsWith(`${scopeRoot}/`) || scopeRoot.startsWith(`${policyRoot}/`);
  }));
}

export function effectivePolicyEffect(policies: PermissionPolicyResource[]): 'deny' | 'ask' | 'allow' | null {
  if (policies.some((policy) => policy.spec.effect === 'deny')) return 'deny';
  if (policies.some((policy) => policy.spec.effect === 'ask')) return 'ask';
  if (policies.some((policy) => policy.spec.effect === 'allow')) return 'allow';
  return null;
}
