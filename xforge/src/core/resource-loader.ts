import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentResource,
  Diagnostic,
  GateResource,
  HookResource,
  McpServerResource,
  PermissionPolicyResource,
  ProjectContext,
  RuleResource,
  ScriptResource,
} from '../types.js';
import { diagnostic } from './errors.js';
import { assertResourceId, normalizeRelative, safeResolve } from './path-safety.js';
import { validateSchema, type SchemaName } from './validator.js';
import { loadYaml } from './yaml.js';
import { normalizeRule } from './governance.js';
import { localizedVariant } from './language.js';
import { exists } from './files.js';

export interface SelectedResources {
  skills: Map<string, string>;
  agents: Map<string, { value: AgentResource; yamlPath: string; instructionsPath: string; instructionPaths: string[]; instructions: string }>;
  rules: Map<string, { value: RuleResource; yamlPath: string }>;
  policies: Map<string, { value: PermissionPolicyResource; yamlPath: string }>;
  hooks: Map<string, { value: HookResource; yamlPath: string }>;
  gates: Map<string, { value: GateResource; yamlPath: string }>;
  scripts: Map<string, { value: ScriptResource; yamlPath: string; entryPath: string }>;
  mcpServers: Map<string, { value: McpServerResource; yamlPath: string }>;
  diagnostics: Diagnostic[];
}

async function loadFlatResource<T extends { metadata?: { name?: string } }>(
  project: ProjectContext,
  kind: 'agents' | 'rules' | 'policies' | 'hooks' | 'gates' | 'mcp-servers',
  id: string,
  schema: SchemaName,
): Promise<{ value: T | null; yamlPath: string; diagnostics: Diagnostic[] }> {
  assertResourceId(id);
  const yamlPath = `xforge/scaffold/${kind}/${id}.yaml`;
  const absolute = await safeResolve(project.root, yamlPath);
  /* `kind` is the directory name, so it is plural; `policies` does not singularize by dropping a
     letter. This message reaches an operator verbatim inside a runtime hook deny, so it is worth
     getting right rather than shipping "Selected policie resource is missing". */
  const singular = kind === 'policies' ? 'PermissionPolicy' : kind.replace(/s$/, '');
  if (!await exists(absolute)) return { value: null, yamlPath, diagnostics: [diagnostic('XFORGE_RESOURCE_MISSING', `Selected ${singular} resource is missing: ${id}`, yamlPath)] };
  const value = await loadYaml<T>(absolute, yamlPath);
  const diagnostics = await validateSchema(schema, value, yamlPath);
  if (value.metadata?.name !== id) diagnostics.push(diagnostic('XFORGE_RESOURCE_NAME_MISMATCH', `Resource metadata.name must equal ${id}.`, yamlPath));
  return { value, yamlPath, diagnostics };
}

export async function loadSelectedResources(project: ProjectContext): Promise<SelectedResources> {
  const diagnostics: Diagnostic[] = [];
  const skills = new Map<string, string>();
  const agents = new Map<string, { value: AgentResource; yamlPath: string; instructionsPath: string; instructionPaths: string[]; instructions: string }>();
  const rules = new Map<string, { value: RuleResource; yamlPath: string }>();
  const policies = new Map<string, { value: PermissionPolicyResource; yamlPath: string }>();
  const hooks = new Map<string, { value: HookResource; yamlPath: string }>();
  const gates = new Map<string, { value: GateResource; yamlPath: string }>();
  const scripts = new Map<string, { value: ScriptResource; yamlPath: string; entryPath: string }>();
  const mcpServers = new Map<string, { value: McpServerResource; yamlPath: string }>();

  for (const id of project.manifest.scaffold.skills) {
    assertResourceId(id);
    const directory = `xforge/scaffold/skills/${id}`;
    const skillPath = `${directory}/SKILL.md`;
    const absolute = await safeResolve(project.root, skillPath);
    if (!await exists(absolute)) diagnostics.push(diagnostic('XFORGE_RESOURCE_MISSING', `Selected Skill is missing: ${id}`, skillPath));
    else {
      if (project.manifest.scaffold.language === 'zh-CN') {
        const localized = `${directory}/${localizedVariant('SKILL.md')}`;
        if (!await exists(await safeResolve(project.root, localized))) {
          diagnostics.push(diagnostic('XFORGE_LOCALIZED_RESOURCE_MISSING', `Selected Skill does not contain its zh-CN entry: ${id}`, localized));
          continue;
        }
      }
      skills.set(id, await safeResolve(project.root, directory));
    }
  }

  for (const id of project.manifest.scaffold.agents) {
    const loaded = await loadFlatResource<AgentResource>(project, 'agents', id, 'agent');
    diagnostics.push(...loaded.diagnostics);
    if (!loaded.value) continue;
    const instruction = normalizeRelative(loaded.value.spec.instructions, `Agent ${id} instructions`);
    const defaultInstructionsPath = `xforge/scaffold/agents/${instruction}`;
    const localizedInstructionsPath = `xforge/scaffold/agents/${localizedVariant(instruction)}`;
    const instructionsPath = project.manifest.scaffold.language === 'zh-CN' ? localizedInstructionsPath : defaultInstructionsPath;
    const absolute = await safeResolve(project.root, instructionsPath);
    if (!await exists(absolute)) {
      diagnostics.push(diagnostic('XFORGE_AGENT_INSTRUCTIONS_MISSING', `Agent instructions are missing: ${instruction}`, loaded.yamlPath));
      continue;
    }
    for (const skill of loaded.value.spec.skills) {
      if (!project.manifest.scaffold.skills.includes(skill)) diagnostics.push(diagnostic('XFORGE_AGENT_SKILL_DISABLED', `Agent ${id} references non-enabled Skill ${skill}.`, loaded.yamlPath));
    }
    const instructionPaths = [defaultInstructionsPath];
    if (await exists(await safeResolve(project.root, localizedInstructionsPath))) instructionPaths.push(localizedInstructionsPath);
    if (project.manifest.scaffold.language === 'zh-CN' && !instructionPaths.includes(localizedInstructionsPath)) {
      diagnostics.push(diagnostic('XFORGE_LOCALIZED_RESOURCE_MISSING', `Agent ${id} does not contain its zh-CN instructions.`, localizedInstructionsPath));
      continue;
    }
    agents.set(id, { value: loaded.value, yamlPath: loaded.yamlPath, instructionsPath, instructionPaths, instructions: await readFile(absolute, 'utf8') });
  }

  for (const id of project.manifest.scaffold.rules) {
    const loaded = await loadFlatResource<RuleResource>(project, 'rules', id, 'rule');
    diagnostics.push(...loaded.diagnostics);
    if (loaded.value) {
      const normalized = normalizeRule(loaded.value);
      if (normalized.constitutionCompatibility === 'conflict') diagnostics.push(diagnostic('XFORGE_CONSTITUTION_RULE_CONFLICT', `Rule ${id} declares a Constitution conflict.`, loaded.yamlPath));
      /* A policy-guarded Rule is enforced — the PreToolUse bridge refuses the call — so counting
         only Gates and Approvals reported "remains guidance" for a Rule that actively denies. The
         three coverage kinds are not equivalent in strength, but they are all enforcement; only a
         Rule backed by none of them is guidance alone. */
      if (normalized.severity === 'must' && normalized.gateRefs.length === 0 && normalized.approvalRefs.length === 0 && normalized.policyRefs.length === 0) {
        diagnostics.push(diagnostic('XFORGE_RULE_NOT_ENFORCED', `Must Rule ${id} declares no Gate, PermissionPolicy, or Approval coverage and remains guidance.`, loaded.yamlPath, 'warning'));
      }
      for (const gate of normalized.gateRefs) if (!project.manifest.scaffold.gates.includes(gate)) diagnostics.push(diagnostic('XFORGE_RULE_GATE_DISABLED', `Rule ${id} references non-enabled Gate ${gate}.`, loaded.yamlPath));
      rules.set(id, { value: loaded.value, yamlPath: loaded.yamlPath });
    }
  }

  for (const id of project.manifest.scaffold.policies ?? []) {
    const loaded = await loadFlatResource<PermissionPolicyResource>(project, 'policies', id, 'permission-policy');
    diagnostics.push(...loaded.diagnostics);
    if (loaded.value) policies.set(id, { value: loaded.value, yamlPath: loaded.yamlPath });
  }

  for (const id of project.manifest.scaffold.hooks) {
    const loaded = await loadFlatResource<HookResource>(project, 'hooks', id, 'hook');
    diagnostics.push(...loaded.diagnostics);
    if (loaded.value) hooks.set(id, { value: loaded.value, yamlPath: loaded.yamlPath });
  }

  for (const id of project.manifest.scaffold.gates) {
    const loaded = await loadFlatResource<GateResource>(project, 'gates', id, 'gate');
    diagnostics.push(...loaded.diagnostics);
    if (loaded.value) {
      if (loaded.value.spec.workingDirectory) {
        try { await safeResolve(project.root, normalizeRelative(loaded.value.spec.workingDirectory, `Gate ${id} workingDirectory`)); }
        catch (error) { diagnostics.push(...(error as { diagnostics?: Diagnostic[] }).diagnostics ?? []); }
      }
      gates.set(id, { value: loaded.value, yamlPath: loaded.yamlPath });
    }
  }

  for (const id of project.manifest.scaffold.mcpServers ?? []) {
    const loaded = await loadFlatResource<McpServerResource>(project, 'mcp-servers', id, 'mcp-server');
    diagnostics.push(...loaded.diagnostics);
    if (loaded.value) mcpServers.set(id, { value: loaded.value, yamlPath: loaded.yamlPath });
  }

  for (const id of project.manifest.scripts ?? []) {
    assertResourceId(id);
    const yamlPath = `xforge/scripts/${id}/script.yaml`;
    const absolute = await safeResolve(project.root, yamlPath);
    if (!await exists(absolute)) {
      diagnostics.push(diagnostic('XFORGE_RESOURCE_MISSING', `Selected Script is missing: ${id}`, yamlPath));
      continue;
    }
    const value = await loadYaml<ScriptResource>(absolute, yamlPath);
    diagnostics.push(...await validateSchema('script', value, yamlPath));
    if (value.metadata?.name !== id) diagnostics.push(diagnostic('XFORGE_RESOURCE_NAME_MISMATCH', `Script metadata.name must equal ${id}.`, yamlPath));
    const entry = normalizeRelative(String(value.spec.entry ?? ''), `Script ${id} entry`);
    const entryPath = `xforge/scripts/${id}/${entry}`;
    if (!await exists(await safeResolve(project.root, entryPath))) diagnostics.push(diagnostic('XFORGE_SCRIPT_ENTRY_MISSING', `Script entry is missing: ${entry}`, yamlPath));
    scripts.set(id, { value, yamlPath, entryPath });
  }

  for (const [id, hook] of hooks) {
    const scriptRef = hook.value.spec.action?.scriptRef;
    if (scriptRef && !scripts.has(scriptRef)) diagnostics.push(diagnostic('XFORGE_HOOK_SCRIPT_MISSING', `Hook ${id} references a non-enabled Script: ${scriptRef}.`, hook.yamlPath));
    if (hook.value.apiVersion === 'xforge.dev/v1alpha2' && hook.value.spec.plane && !hook.value.spec.event.startsWith(hook.value.spec.plane === 'runtime' ? 'agent.' : '') && hook.value.spec.plane === 'runtime') {
      diagnostics.push(diagnostic('XFORGE_HOOK_PLANE_EVENT_MISMATCH', `Runtime Hook ${id} must use an agent.* event.`, hook.yamlPath));
    }
  }

  return { skills, agents, rules, policies, hooks, gates, scripts, mcpServers, diagnostics };
}
