import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, FileChange, ProjectContext, StageFlow } from '../types.js';
import { checkStructure } from '../core/checker.js';
import { diagnostic } from '../core/errors.js';
import { assertManaged } from '../core/project-loader.js';
import { flowArchiveOperation, isStageFlow, loadFlows } from '../core/flow-resolver.js';
import { normalizeRule } from '../core/governance.js';
import { safeResolve } from '../core/path-safety.js';
import { loadYaml } from '../core/yaml.js';
import { capabilityGapDiagnostics } from '../install/planner.js';
import { resolveVerificationPlan } from '../core/verification.js';

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
  summary: { dangling: number; deadCode: number; uncited: number; unusedFlows: number; unusableApprovals: number; suggestions: number };
  danglingReferences: DoctorFinding[];
  deadCode: DoctorFinding[];
  uncited: DoctorFinding[];
  unusedFlows: DoctorFinding[];
  unusableApprovals: DoctorFinding[];
  /**
   * Things a project could have and does not, reported as `info`.
   *
   * Distinct from every other list here, which reports something declared that does not resolve.
   * A project with no architecture file is not misconfigured — it is a project that has not written
   * its architecture down, and saying so is worth exactly one suggestion and no more. Reporting it
   * as a problem would push projects into creating an empty file to silence the tool, and a file
   * that exists but says nothing is worse than none: it reads as configured.
   */
  suggestions: DoctorFinding[];
}

// Built-in Skills that are never invoked from a Flow Stage by design (chat-driven, standalone).
const STANDALONE_SKILLS = new Set(['xforge-explore', 'xforge-kanban', 'xforge-status', 'xforge-continue', 'xforge-revise', 'xforge-scaffold', 'xforge-archive', 'xforge-architect', 'xforge-upgrade-scaffold']);

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
  XFORGE_FLOW_GOVERNANCE_MISSING: 'flows',
  XFORGE_HOOK_EVENT_UNSUPPORTED: 'hooks',
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
  /* A Hook whose event no enabled target exposes is a dangling extension in exactly the sense
     doctor reports: selected, but it can never fire. Produced by the projection planner rather than
     checkStructure, so doctor asks for it directly instead of waiting for the next install.
     XFORGE_POLICY_STATIC_LAYER_DEGRADED is deliberately NOT mapped here — such a policy is still
     enforced, by the runtime Hook bridge instead of the static layer, so it is degraded rather than
     dangling. It also fires for the shipped `protected-files` policy on every run, and a permanent
     finding teaches readers to ignore the report. `install` reports it situationally instead. */
  const projectionDiagnostics = capabilityGapDiagnostics(structure.resources, project.manifest.targets);
  for (const item of [...structure.diagnostics, ...projectionDiagnostics]) {
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
  const unusableApprovals: DoctorFinding[] = [];

  /* Mirrors how `approve`/`control-plane` resolve a provider id at runtime: `local` is always
     available for interactive approval, an `mcp` provider needs a manifest entry that points at an
     enabled McpServer resource whose command is not an obvious placeholder. A policy backed by no
     usable provider can never actually collect an approval — reported here as an advisory, the same
     as every other doctor finding, so it only escalates when `--strict` is set. */
  function providerUsability(providerId: string): { usable: boolean; reason: string } {
    if (providerId === 'local') return { usable: true, reason: 'local is always usable' };
    const provider = project.manifest.approvals?.providers.find((item) => item.id === providerId);
    if (!provider) return { usable: false, reason: 'not declared under manifest approvals.providers' };
    const server = structure.resources.mcpServers.get(provider.mcpServer);
    if (!server) return { usable: false, reason: `references McpServer ${provider.mcpServer}, which is not an enabled resource` };
    const { transport, command, url } = server.value.spec;
    const commandText = transport === 'http' ? (url ?? '') : (command ?? []).join(' ');
    const looksPlaceholder = !commandText.trim() || /not[-\s]?configured|placeholder/i.test(commandText);
    if (looksPlaceholder) return { usable: false, reason: `McpServer ${provider.mcpServer} ${transport === 'http' ? 'url' : 'command'} looks like an unconfigured placeholder` };
    return { usable: true, reason: 'McpServer resolves to a configured command' };
  }

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
      for (const policy of flow.governance?.approvalPolicies ?? []) {
        const checks = policy.providers.map((providerId) => ({ providerId, ...providerUsability(providerId) }));
        if (checks.some((check) => check.usable)) continue;
        const detail = checks.length
          ? checks.map((check) => `${check.providerId} (${check.reason})`).join('; ')
          : 'the policy declares no providers at all';
        unusableApprovals.push({
          scope: 'approvals',
          code: 'XFORGE_DOCTOR_APPROVAL_POLICY_UNUSABLE',
          id: policy.id,
          message: `Approval policy ${policy.id} in Flow ${name} has no usable provider: ${detail}.`,
          path: filePath,
        });
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
  /*
   * Only asked once the project has a Change to answer it with.
   *
   * Three Flows ship and one is the Manifest default, so on a project with nothing in flight this
   * check reported exactly two findings, every run, on every project — including the Flow the
   * operator was about to use. Nothing can be done about them, which makes them the permanent
   * finding this file already refuses to emit elsewhere: see the note on
   * XFORGE_POLICY_STATIC_LAYER_DEGRADED above, which is excluded for precisely this reason. An
   * unused Flow is only evidence of anything once Changes exist and still none of them chose it.
   */
  if (changeDirectories.length > 0) for (const name of flowResult.flows.keys()) {
    if (!usedFlows.has(name)) unusedFlows.push({
      scope: 'flows',
      code: 'XFORGE_DOCTOR_UNUSED_FLOW',
      id: name,
      message: `Flow ${name} is not the Manifest default and is not used by any active Change.`,
      path: `xforge/flows/${name}.yaml`,
    });
  }

  /*
   * The architecture file is suggested, never required.
   *
   * `xforge/architecture.md` is where a project records the few decisions whose reversal touches
   * several modules — the ones that otherwise live in a single Change's design document and archive
   * with it, leaving the next Change nothing to inherit. A project without one is not misconfigured,
   * so this is an `info` suggestion and nothing more: made a warning, it would push projects into
   * creating an empty file to silence the tool, and an architecture file that exists and says
   * nothing is worse than none, because it reads as configured.
   */
  const suggestions: DoctorFinding[] = [];
  if (project.manifest.scaffold.skills.includes('xforge-architect')
    && !await exists(path.join(project.root, 'xforge', 'architecture.md'))) {
    suggestions.push({
      scope: 'skills',
      code: 'XFORGE_DOCTOR_ARCHITECTURE_ABSENT',
      id: 'xforge-architect',
      message: 'This project has no xforge/architecture.md, so each Change designs without a durable record of the decisions the last one made. Run the xforge-architect Skill to write one — from the existing code, by answering a few questions, or from a description. It is a suggestion, not a requirement: nothing is blocked without it.',
      path: 'xforge/architecture.md',
      severity: 'info',
    });
  }

  /*
   * ISSUE-7: a required `declared` Gate that has never been answered, reported at project setup
   * rather than mid-Change.
   *
   * `builtin: declared` Gates refuse rather than guess, which is the right refusal and the reason
   * `unit-tests` stopped being a decoration on non-npm projects. But the refusal arrives the first
   * time a Change reaches the Stage that runs the Gate — in a live XOps run, partway through the
   * project's first Change, as a blocked maintenance action. The question is answerable on day one
   * and nothing about it depends on a Change existing.
   *
   * `resolveVerificationPlan` is the runner's own resolver, used here so the two cannot drift: a
   * dismissal counts as an answer exactly as it does at Gate time. This stays a suggestion, not a
   * finding — an unanswered question is not a misconfiguration, and the Gate itself still refuses.
   */
  for (const gateId of project.manifest.scaffold.gates) {
    const resource = structure.resources.gates.get(gateId);
    if (resource?.value.spec.builtin !== 'declared' || !resource.value.spec.required) continue;
    if (!referencedGates.has(gateId)) continue;
    const plan = await resolveVerificationPlan(project, gateId);
    if (plan.runs.length > 0 || plan.dismissals.length > 0) continue;
    suggestions.push({
      scope: 'gates',
      code: 'XFORGE_DOCTOR_VERIFICATION_UNDECLARED',
      id: gateId,
      message: `Gate ${gateId} is required and runs whatever this project declares under manifest.verification.${gateId}, which is currently empty. It will refuse the first time a Change reaches the Stage that runs it. Answer it now with \`xforge verification declare --gate-name ${gateId} --command '[\"cargo\",\"test\"]' --by <person>\`, substituting the command this project actually verifies itself with. Do not answer it with whatever command happens to exist: a test command on a repository that has no tests passes this Gate while asserting nothing.`,
      path: 'xforge/manifest.yaml',
      severity: 'info',
    });
  }

  /*
   * ISSUE-6: whether this project can collect an approval without a human at a terminal.
   *
   * Deliberately not folded into XFORGE_DOCTOR_APPROVAL_POLICY_UNUSABLE above, and deliberately not
   * done by making `local` unusable. `local` *is* usable — a person opens a terminal and types the
   * decision, which is the anchor of the whole approval design and not a defect. What an
   * agent-driven project needs to know is the shape of that: every approval will interrupt the
   * session and require someone to leave it. That is a fact about how the project will feel to
   * work in, worth stating once at setup, and it was previously discoverable only by hitting
   * XFORGE_APPROVAL_INTERACTIVE_REQUIRED at the first approval — twice, in the run that reported it.
   */
  const approvalPolicies = [...flowResult.flows.values()]
    .filter(isStageFlow)
    .flatMap((flow) => flow.governance?.approvalPolicies ?? []);
  const nonInteractive = approvalPolicies.some((policy) => policy.providers.some(
    (providerId) => providerId !== 'local' && providerUsability(providerId).usable,
  ));
  if (approvalPolicies.length > 0 && !nonInteractive) {
    suggestions.push({
      scope: 'approvals',
      code: 'XFORGE_DOCTOR_APPROVALS_INTERACTIVE_ONLY',
      id: 'local',
      message: 'Every approval policy in this project can be satisfied only at an interactive terminal: no mcp provider is both declared and configured. Approvals will therefore not be collectable from inside an Agent session — the approver has to open a real terminal each time. That is a working constraint, not a misconfiguration; the alternative is to configure an mcp approval provider. See docs/extending-approvals-with-mcp.md.',
      path: 'xforge/manifest.yaml',
      severity: 'info',
    });
  }

  const matchesKind = (finding: DoctorFinding): boolean => !options.kind || finding.scope === options.kind;
  const filtered: DoctorData = {
    kind: options.kind ?? 'all',
    summary: { dangling: 0, deadCode: 0, uncited: 0, unusedFlows: 0, unusableApprovals: 0, suggestions: 0 },
    danglingReferences: danglingReferences.filter(matchesKind),
    deadCode: deadCode.filter(matchesKind),
    uncited: uncited.filter(matchesKind),
    unusedFlows: unusedFlows.filter(matchesKind),
    unusableApprovals: unusableApprovals.filter(matchesKind),
    suggestions: suggestions.filter(matchesKind),
  };
  filtered.summary = {
    dangling: filtered.danglingReferences.length,
    deadCode: filtered.deadCode.length,
    uncited: filtered.uncited.length,
    unusedFlows: filtered.unusedFlows.length,
    unusableApprovals: filtered.unusableApprovals.length,
    suggestions: filtered.suggestions.length,
  };

  for (const finding of [...filtered.danglingReferences, ...filtered.deadCode, ...filtered.uncited, ...filtered.unusedFlows, ...filtered.unusableApprovals]) {
    diagnostics.push(diagnostic(finding.code, finding.message, finding.path, 'warning'));
  }
  /* Suggestions never reach `hasFindings`, so `--strict` stays a statement about what is broken. */
  for (const finding of filtered.suggestions) {
    diagnostics.push(diagnostic(finding.code, finding.message, finding.path, 'info'));
  }

  const hasFindings = filtered.summary.dangling + filtered.summary.deadCode + filtered.summary.uncited + filtered.summary.unusedFlows + filtered.summary.unusableApprovals > 0;
  if (options.strict && hasFindings) {
    diagnostics.push(diagnostic('XFORGE_DOCTOR_STRICT', 'doctor found issues and --strict is set.', undefined, 'error'));
  }

  return { data: filtered, diagnostics, changes: [] };
}
