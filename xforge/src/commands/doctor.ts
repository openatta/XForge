import { access, readdir } from 'node:fs/promises';
import type { Diagnostic, FileChange, ProjectContext, StageFlow } from '../types.js';
import { checkStructure } from '../core/checker.js';
import { diagnostic } from '../core/errors.js';
import { assertManaged } from '../core/project-loader.js';
import { flowArchiveOperation, isStageFlow, loadFlows } from '../core/flow-resolver.js';
import { normalizeRule } from '../core/governance.js';
import { safeResolve } from '../core/path-safety.js';
import { loadYaml } from '../core/yaml.js';

export type DoctorKind = 'skills' | 'agents' | 'rules' | 'policies' | 'hooks' | 'gates' | 'scripts' | 'flows' | 'approvals' | 'mcp-servers';
type DoctorScope = 'skills' | 'agents' | 'rules' | 'policies' | 'hooks' | 'gates' | 'flows' | 'approvals' | 'mcp-servers';

export interface DoctorFinding {
  scope: DoctorScope;
  code: string;
  id?: string;
  message: string;
  path?: string;
  severity?: Diagnostic['severity'];
}

export interface DoctorData {
  kind: DoctorKind | 'all';
  summary: { dangling: number; deadCode: number; uncited: number; unusedFlows: number };
  danglingReferences: DoctorFinding[];
  deadCode: DoctorFinding[];
  uncited: DoctorFinding[];
  unusedFlows: DoctorFinding[];
}

// Built-in Skills that are never invoked from a Flow Stage by design (chat-driven, standalone).
const STANDALONE_SKILLS = new Set(['xforge-explore', 'xforge-kanban', 'xforge-status', 'xforge-continue', 'xforge-revise', 'xforge-scaffold', 'xforge-archive']);

const DANGLING_CODE_SCOPE: Record<string, DoctorScope> = {
  XFORGE_FLOW_GATE_MISSING: 'gates',
  XFORGE_FLOW_GATE_DISABLED: 'gates',
  XFORGE_FLOW_SKILL_MISSING: 'skills',
  XFORGE_FLOW_SKILL_DISABLED: 'skills',
  XFORGE_RULE_MODULE_UNKNOWN: 'rules',
  XFORGE_RULE_APPROVAL_UNKNOWN: 'approvals',
  XFORGE_RULE_GATE_DISABLED: 'rules',
  XFORGE_HOOK_SCRIPT_MISSING: 'hooks',
  XFORGE_AGENT_CALLER_UNKNOWN: 'agents',
  XFORGE_AGENT_SKILL_DISABLED: 'skills',
  XFORGE_APPROVAL_MCP_SERVER_UNKNOWN: 'mcp-servers',
};

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function activeChangeDirectories(project: ProjectContext): Promise<string[]> {
  const absolute = await safeResolve(project.root, project.changesPath);
  try {
    return (await readdir(absolute, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function stageGateReferences(flow: StageFlow): string[] {
  return [
    ...flow.stages.flatMap((stage) => [...(stage.gates ?? []), ...(stage.exit?.gates ?? [])]),
    ...flowArchiveOperation(flow).mandatoryGates,
  ];
}

function stageApprovalReferences(flow: StageFlow): string[] {
  return [
    ...flow.stages.flatMap((stage) => stage.exit?.approvals ?? []),
    ...(flow.terminal.archive.approvals ?? []),
  ];
}

export async function executeDoctor(project: ProjectContext, options: { kind?: DoctorKind; strict: boolean }): Promise<{
  data: DoctorData;
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'doctor');
  const structure = await checkStructure(project);
  const diagnostics: Diagnostic[] = [];

  const danglingReferences: DoctorFinding[] = [];
  for (const item of structure.diagnostics) {
    const scope = DANGLING_CODE_SCOPE[item.code];
    if (!scope) continue;
    danglingReferences.push({ scope, code: item.code, message: item.message, path: item.path, severity: item.severity });
  }

  const flowResult = await loadFlows(project);
  const referencedGates = new Set<string>();
  const referencedSkills = new Set<string>();
  const referencedPolicies = new Set<string>();
  const deadCode: DoctorFinding[] = [];
  const unusedFlows: DoctorFinding[] = [];

  for (const [name, flow] of flowResult.flows) {
    const filePath = `xforge/flows/${name}.yaml`;
    if (isStageFlow(flow)) {
      for (const gate of stageGateReferences(flow)) referencedGates.add(gate);
      for (const stage of flow.stages) referencedSkills.add(stage.skill);
      referencedSkills.add(flow.terminal.archive.handler);
      const declaredApprovals = new Set((flow.governance?.approvalPolicies ?? []).map((policy) => policy.id));
      const referencedApprovals = new Set(stageApprovalReferences(flow));
      for (const policyId of declaredApprovals) {
        if (!referencedApprovals.has(policyId)) {
          deadCode.push({
            scope: 'approvals',
            code: 'XFORGE_DOCTOR_DEAD_CODE',
            id: policyId,
            message: `Approval policy ${policyId} is declared by Flow ${name} but never referenced by any Stage exit or the archive terminal.`,
            path: filePath,
          });
        }
      }
    } else {
      for (const gate of flow.operations.archive.mandatoryGates) referencedGates.add(gate);
    }
  }

  for (const gate of project.manifest.scaffold.gates) {
    if (!referencedGates.has(gate)) deadCode.push({
      scope: 'gates',
      code: 'XFORGE_DOCTOR_DEAD_CODE',
      id: gate,
      message: `Gate ${gate} is enabled but not referenced by any Flow Stage, Stage exit, or archive terminal — it will never run.`,
      path: `xforge/scaffold/gates/${gate}.yaml`,
    });
  }

  const uncited: DoctorFinding[] = [];
  for (const skill of project.manifest.scaffold.skills) {
    if (STANDALONE_SKILLS.has(skill)) continue;
    if (!referencedSkills.has(skill)) uncited.push({
      scope: 'skills',
      code: 'XFORGE_DOCTOR_UNCITED',
      id: skill,
      message: `Skill ${skill} is enabled but not referenced as a Flow Stage or archive handler. It may still be invoked directly; verify it is not orphaned.`,
      path: `xforge/scaffold/skills/${skill}`,
    });
  }

  for (const [, rule] of structure.resources.rules) {
    const normalized = normalizeRule(rule.value);
    for (const policyRef of normalized.policyRefs) referencedPolicies.add(policyRef);
  }
  for (const policy of project.manifest.scaffold.policies ?? []) {
    if (!referencedPolicies.has(policy)) uncited.push({
      scope: 'policies',
      code: 'XFORGE_DOCTOR_UNCITED',
      id: policy,
      message: `PermissionPolicy ${policy} is enabled but not cited by any Rule's policyRefs. It still applies live to matching tool calls; verify it is intentionally freestanding.`,
      path: `xforge/scaffold/policies/${policy}.yaml`,
    });
  }

  const referencedMcpServers = new Set((project.manifest.approvals?.providers ?? []).filter((item) => item.type === 'mcp').map((item) => item.mcpServer));
  for (const mcpServer of project.manifest.scaffold.mcpServers ?? []) {
    if (!referencedMcpServers.has(mcpServer)) uncited.push({
      scope: 'mcp-servers',
      code: 'XFORGE_DOCTOR_UNCITED',
      id: mcpServer,
      message: `McpServer ${mcpServer} is enabled but not referenced by any approvals.providers entry's mcpServer field. It has no effect until a provider points at it; verify it is intentionally staged ahead of use.`,
      path: `xforge/scaffold/mcp-servers/${mcpServer}.yaml`,
    });
  }

  const changeDirectories = await activeChangeDirectories(project);
  const usedFlows = new Set<string>([project.manifest.flow]);
  for (const changeId of changeDirectories) {
    const changePath = `${project.changesPath}/${changeId}/change.yaml`;
    const absolute = await safeResolve(project.root, changePath);
    if (!await exists(absolute)) continue;
    try {
      const config = await loadYaml<{ flow?: string }>(absolute, changePath);
      usedFlows.add(config.flow ?? project.manifest.flow);
    } catch {
      // Malformed change.yaml is reported elsewhere by checkStructure; doctor only reads the flow field.
    }
  }
  for (const name of flowResult.flows.keys()) {
    if (!usedFlows.has(name)) unusedFlows.push({
      scope: 'flows',
      code: 'XFORGE_DOCTOR_UNUSED_FLOW',
      id: name,
      message: `Flow ${name} is not the Manifest default and is not used by any active Change.`,
      path: `xforge/flows/${name}.yaml`,
    });
  }

  const matchesKind = (finding: DoctorFinding): boolean => !options.kind || finding.scope === options.kind;
  const filtered: DoctorData = {
    kind: options.kind ?? 'all',
    summary: { dangling: 0, deadCode: 0, uncited: 0, unusedFlows: 0 },
    danglingReferences: danglingReferences.filter(matchesKind),
    deadCode: deadCode.filter(matchesKind),
    uncited: uncited.filter(matchesKind),
    unusedFlows: unusedFlows.filter(matchesKind),
  };
  filtered.summary = {
    dangling: filtered.danglingReferences.length,
    deadCode: filtered.deadCode.length,
    uncited: filtered.uncited.length,
    unusedFlows: filtered.unusedFlows.length,
  };

  for (const finding of [...filtered.danglingReferences, ...filtered.deadCode, ...filtered.uncited, ...filtered.unusedFlows]) {
    diagnostics.push(diagnostic(finding.code, finding.message, finding.path, 'warning'));
  }

  const hasFindings = filtered.summary.dangling + filtered.summary.deadCode + filtered.summary.uncited + filtered.summary.unusedFlows > 0;
  if (options.strict && hasFindings) {
    diagnostics.push(diagnostic('XFORGE_DOCTOR_STRICT', 'doctor found issues and --strict is set.', undefined, 'error'));
  }

  return { data: filtered, diagnostics, changes: [] };
}
