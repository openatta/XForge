import { access, readFile, readdir } from 'node:fs/promises';
import fg from 'fast-glob';
import path from 'node:path';
import type { Diagnostic, FileChange, ProjectContext, StageFlow } from '../types.js';
import { checkStructure } from '../core/checker.js';
import { diagnostic } from '../core/errors.js';
import { assertManaged } from '../core/project-loader.js';
import { flowArchiveOperation, isStageFlow, loadFlows } from '../core/flow-resolver.js';
import { loadBundledScaffold } from '../core/bundled-scaffold.js';
import { CLI_NAME, CLI_VERSION } from '../constants.js';
import { flowSkillConformanceDiagnostics } from '../core/flow-skill-conformance.js';
import { normalizeRule } from '../core/governance.js';
import { sha256 } from '../core/hash.js';
import { safeResolve } from '../core/path-safety.js';
import { parse as parseYaml } from 'yaml';
import { loadYaml } from '../core/yaml.js';
import { capabilityGapDiagnostics } from '../install/planner.js';
import { verificationEntriesFor } from '../core/verification.js';

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
  summary: { dangling: number; deadCode: number; uncited: number; unusedFlows: number; unusableApprovals: number; conformance: number; suggestions: number };
  danglingReferences: DoctorFinding[];
  deadCode: DoctorFinding[];
  uncited: DoctorFinding[];
  unusedFlows: DoctorFinding[];
  unusableApprovals: DoctorFinding[];
  /**
   * Stages whose Skill does not cover what the Stage requires of it.
   *
   * Its own list rather than a dangling reference, because every reference here *resolves*: the
   * Flow names a Skill that exists and is enabled. What fails is narrower and invisible to every
   * other check — the Skill an Agent will be holding at that Stage never mentions the file it must
   * write, the command that clears its Gate, or the condition that holds its door shut.
   */
  conformance: DoctorFinding[];
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
  /* A Stage whose Skill is not told about the Stage's own gates. The reference resolves — which is
     why every other check here passes it — but what it resolves to does not cover the job. */
  XFORGE_FLOW_SKILL_ARTIFACT_UNNAMED: 'skills',
  XFORGE_FLOW_SKILL_DECLARED_GATE_UNCOVERED: 'skills',
  XFORGE_FLOW_SKILL_CONDITION_UNNAMED: 'skills',
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
  /*
   * Flow/Skill conformance, over the Flows this project actually runs.
   *
   * `usedFlows` and not every Flow in the project, for the reason spelled out just above: three
   * Flows ship, and a finding about a Flow nobody has chosen is not something anybody is going to
   * act on. Unlike the unused-Flow check this is not gated on `changeDirectories.length`, because
   * the Manifest default is always in `usedFlows` — a project with nothing in flight still has one
   * Flow it is about to run, and a Skill that cannot clear that Flow's Stages is worth knowing
   * before the first Change rather than after.
   */
  const conformance: DoctorFinding[] = [];
  for (const [name, flow] of flowResult.flows) {
    if (!usedFlows.has(name) || !isStageFlow(flow)) continue;
    for (const item of await flowSkillConformanceDiagnostics(flow, structure.resources)) {
      conformance.push({ scope: 'skills', code: item.code, message: item.message, path: item.path });
    }
  }

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
   * A Rule whose `scope.paths` match nothing in this repository.
   *
   * Two independent readers consume that list and they read it differently. XForge compares it with
   * the paths a Change declares in `change.yaml`, which is what decides whether the Rule reaches the
   * Agent's instruction context at all. The Adapters hand the same list to the host as a native file
   * matcher — Claude's `paths:`, Copilot's `applyTo:`, Cursor's `globs:` — where it genuinely is a
   * filesystem glob. Both readings fail together on a layout the scope was not written for, and
   * neither says so: the shipped `src/**` / `tests/**` is a guess about repository shape, and in a
   * monorepo whose code lives under `apps/` and `packages/` it matches no file and no Change.
   *
   * Globbing the repository is the check that catches this, because it is the one question with an
   * answer that does not depend on which Change happens to be open. `info`, and never a failure: a
   * scope may legitimately name paths that do not exist yet.
   */
  for (const [name, rule] of structure.resources.rules) {
    const paths = normalizeRule(rule.value).paths;
    if (paths.length === 0) continue;
    const matches = await fg(paths, {
      cwd: project.root, onlyFiles: true, followSymbolicLinks: false, dot: false, unique: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });
    if (matches.length > 0) continue;
    suggestions.push({
      scope: 'rules',
      code: 'XFORGE_DOCTOR_RULE_SCOPE_EMPTY',
      id: name,
      message: `Rule ${name} is scoped to ${paths.join(', ')}, which matches no file in this repository. XForge compares that list with the paths a Change declares in change.yaml, and the installed Adapters hand it to the host as a file matcher; on this layout both come up empty, so the Rule is registered, enforceable, and reaching nothing. Rewrite scope.paths to the paths this repository actually uses, or drop it to have the Rule apply everywhere.`,
      path: `xforge/scaffold/rules/${name}.yaml`,
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
   * The condition below mirrors the runner's own refusal so the two cannot drift; see it for why a
   * dismissal does not count as an answer. This stays a suggestion, not a finding — an unanswered
   * question is not a misconfiguration, and the Gate itself still refuses.
   */
  for (const gateId of project.manifest.scaffold.gates) {
    const resource = structure.resources.gates.get(gateId);
    if (resource?.value.spec.builtin !== 'declared' || !resource.value.spec.required) continue;
    if (!referencedGates.has(gateId)) continue;
    /*
     * `runs` alone, matching the runner's own refusal exactly (`runners/gate.ts`: a `declared` Gate
     * refuses when `plan.runs.length === 0`). A dismissal records a toolchain the Gate deliberately
     * does not cover; it is not a command, so a Gate holding only dismissals still has nothing to
     * run and still refuses. Treating a dismissal as an answer here would have gone quiet about a
     * Gate that was going to block anyway.
     */
    const { runs } = verificationEntriesFor(project, gateId);
    if (runs.length > 0) continue;
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
  /*
   * Asked per policy, over the Flows this project actually uses.
   *
   * Flattening every Flow's policies into one set and suppressing on any usable provider anywhere
   * got the customized case backwards: a project running `quick` (local only) that also ships a
   * `release` Flow with a configured mcp provider was told nothing, and still met
   * XFORGE_APPROVAL_INTERACTIVE_REQUIRED at its first approval — the failure this exists to warn
   * about. Scoped to `usedFlows` for the same reason the unused-Flow check is: a policy in a Flow
   * nobody has chosen is not a constraint anybody is under. Still one finding rather than one per
   * Flow, naming which policies are affected, because a per-Flow fan-out on a stock project would
   * be three copies of one fact.
   */
  const interactiveOnly: string[] = [];
  for (const [name, flow] of flowResult.flows) {
    if (!usedFlows.has(name) || !isStageFlow(flow)) continue;
    for (const policy of flow.governance?.approvalPolicies ?? []) {
      if (policy.providers.some((providerId) => providerId !== 'local' && providerUsability(providerId).usable)) continue;
      /*
       * "Only at a terminal" is a claim about `local`, so a policy that does not declare `local` is
       * not this finding. It is the stronger one — XFORGE_DOCTOR_APPROVAL_POLICY_UNUSABLE, already
       * raised above for the same policy, since no provider it declares is usable either. Reporting
       * both told the reader to open a real terminal for an approval that `xforge approve` refuses
       * outright with XFORGE_APPROVAL_PROVIDER_FORBIDDEN: two findings, one of them false, about
       * one policy.
       */
      if (!policy.providers.includes('local')) continue;
      interactiveOnly.push(`${name}/${policy.id}`);
    }
  }
  if (interactiveOnly.length > 0) {
    suggestions.push({
      scope: 'approvals',
      code: 'XFORGE_DOCTOR_APPROVALS_INTERACTIVE_ONLY',
      id: 'local',
      message: `${interactiveOnly.length} approval polic${interactiveOnly.length === 1 ? 'y' : 'ies'} in the Flows this project uses can be satisfied only at an interactive terminal, because no mcp provider is both declared and configured for ${interactiveOnly.length === 1 ? 'it' : 'them'}: ${interactiveOnly.join(', ')}. Those approvals cannot be collected from inside an Agent session — the approver has to open a real terminal each time. That is a working constraint, not a misconfiguration; the alternative is to configure an mcp approval provider. See docs/extension-guide.md.`,
      path: 'xforge/manifest.yaml',
      severity: 'info',
    });
  }

  /*
   * Flow versions the project runs, against the versions this CLI ships.
   *
   * `xforge/flows/` was outside `xforge/scaffold/`, the only tree `upgrade-scaffold` then walked, so
   * a Flow never moved when a project upgraded and nothing had ever said so. A project ran an
   * entire Major three CLI releases behind its own toolchain -- two approvers where the shipped
   * Flow asks for one non-implementer, and a Check Stage missing from `verify.reworkTo` -- and
   * found out by reading the payload by hand. The upgrade now walks both trees, so the drift has a
   * repair; this is still what makes it visible before somebody goes looking, because `install`
   * does not compare Flow versions and a project only upgrades when it decides to.
   *
   * Reported as `info`, and worded as a comparison rather than a defect, because customising a Flow
   * is a supported thing to do: a project that deliberately requires two approvers is not
   * misconfigured, and a warning it can never clear would teach it to skim past the whole report.
   *
   * A failure to read the bundled payload is not a finding at all. `loadBundledScaffold` throws on
   * a missing payload, a digest mismatch, a symlink, or a protocol mismatch, and doctor is the
   * command a person runs when the installation is already suspect -- it has to survive that and
   * report everything else.
   */
  let bundledFlows: Map<string, { version: string; digest: string }> | null = null;
  try {
    const bundled = await loadBundledScaffold();
    bundledFlows = new Map();
    for (const [relative, content] of bundled.files) {
      const match = /^xforge\/flows\/([^/]+)\.yaml$/.exec(relative);
      if (!match) continue;
      try {
        const parsed = parseYaml(content.toString('utf8'), { strict: true, uniqueKeys: true }) as { metadata?: { version?: unknown } };
        const version = parsed?.metadata?.version;
        if (version !== undefined && version !== null) {
          bundledFlows.set(match[1]!, { version: String(version), digest: sha256(content) });
        }
      } catch { /* An unparseable payload Flow is the package's problem, not this project's. */ }
    }
  } catch { bundledFlows = null; }
  if (bundledFlows) {
    for (const [name, flow] of flowResult.flows) {
      const shipped = bundledFlows.get(name);
      const local = String(flow.metadata.version ?? '');
      if (!shipped || !local) continue;
      const relative = `xforge/flows/${name}.yaml`;
      let localDigest: string | null = null;
      try { localDigest = sha256(await readFile(await safeResolve(project.root, relative))); } catch { localDigest = null; }
      const sameVersion = shipped.version === local;
      const sameBytes = localDigest !== null && localDigest === shipped.digest;
      if (sameVersion && (sameBytes || localDigest === null)) continue;

      /*
       * Two different findings, because they have different repairs.
       *
       * A version behind is the ordinary case: the project was initialised before a Flow moved, and
       * has not run the `upgrade-scaffold` that would stage the newer one beside it.
       *
       * A version that matches while the bytes do not is the one a version comparison alone would
       * miss, and it is the more interesting of the two -- either the Flow was edited in place
       * without moving its version, or it was adopted from a build that shipped different content
       * under the same number. The RUNBOOK records the same trap for the globally installed CLI
       * ("only comparing version numbers misses the commonest kind of staleness"); this is that
       * lesson applied to the one governed asset no upgrade path touches.
       */
      suggestions.push(sameVersion ? {
        scope: 'flows',
        code: 'XFORGE_DOCTOR_FLOW_CONTENT_DRIFT',
        id: name,
        message: `Flow ${name} says version ${local}, the same version ${CLI_NAME}@${CLI_VERSION} ships, but its content differs. Either it was edited without moving its version, or it came from a build that shipped different bytes under that number — and because the two agree on the number, nothing else will ever report it. Move the version if the edit was deliberate, so the difference has a name.`,
        path: relative,
        severity: 'info',
      } : {
        scope: 'flows',
        code: 'XFORGE_DOCTOR_FLOW_VERSION_DRIFT',
        id: name,
        message: `Flow ${name} is at version ${local}; ${CLI_NAME}@${CLI_VERSION} ships version ${shipped.version}. Run xforge upgrade-scaffold to stage the shipped Flow beside yours and decide -- a Flow states how many approvals a Stage needs and where a blocker sends the work back, so it is brought, never adopted for you. If the difference is deliberate, record that at the top of ${relative} so the next reader does not take it for a missed upgrade.`,
        path: relative,
        severity: 'info',
      });
    }
  }

  const matchesKind = (finding: DoctorFinding): boolean => !options.kind || finding.scope === options.kind;
  const filtered: DoctorData = {
    kind: options.kind ?? 'all',
    summary: { dangling: 0, deadCode: 0, uncited: 0, unusedFlows: 0, unusableApprovals: 0, conformance: 0, suggestions: 0 },
    danglingReferences: danglingReferences.filter(matchesKind),
    deadCode: deadCode.filter(matchesKind),
    uncited: uncited.filter(matchesKind),
    unusedFlows: unusedFlows.filter(matchesKind),
    unusableApprovals: unusableApprovals.filter(matchesKind),
    conformance: conformance.filter(matchesKind),
    suggestions: suggestions.filter(matchesKind),
  };
  filtered.summary = {
    dangling: filtered.danglingReferences.length,
    deadCode: filtered.deadCode.length,
    uncited: filtered.uncited.length,
    unusedFlows: filtered.unusedFlows.length,
    unusableApprovals: filtered.unusableApprovals.length,
    conformance: filtered.conformance.length,
    suggestions: filtered.suggestions.length,
  };

  for (const finding of [...filtered.danglingReferences, ...filtered.deadCode, ...filtered.uncited, ...filtered.unusedFlows, ...filtered.unusableApprovals, ...filtered.conformance]) {
    diagnostics.push(diagnostic(finding.code, finding.message, finding.path, 'warning'));
  }
  /* Suggestions never reach `hasFindings`, so `--strict` stays a statement about what is broken. */
  for (const finding of filtered.suggestions) {
    diagnostics.push(diagnostic(finding.code, finding.message, finding.path, 'info'));
  }

  const hasFindings = filtered.summary.dangling + filtered.summary.deadCode + filtered.summary.uncited + filtered.summary.unusedFlows + filtered.summary.unusableApprovals + filtered.summary.conformance > 0;
  if (options.strict && hasFindings) {
    diagnostics.push(diagnostic('XFORGE_DOCTOR_STRICT', 'doctor found issues and --strict is set.', undefined, 'error'));
  }

  return { data: filtered, diagnostics, changes: [] };
}
