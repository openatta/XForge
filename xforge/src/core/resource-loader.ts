import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentResource,
  Diagnostic,
  GateResource,
  HookResource,
  ProjectContext,
  RuleResource,
  ScriptResource,
} from '../types.js';
import { diagnostic } from './errors.js';
import { assertResourceId, normalizeRelative, safeResolve } from './path-safety.js';
import { validateSchema, type SchemaName } from './validator.js';
import { loadYaml } from './yaml.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

export interface SelectedResources {
  skills: Map<string, string>;
  agents: Map<string, { value: AgentResource; yamlPath: string; instructionsPath: string; instructions: string }>;
  rules: Map<string, { value: RuleResource; yamlPath: string }>;
  hooks: Map<string, { value: HookResource; yamlPath: string }>;
  gates: Map<string, { value: GateResource; yamlPath: string }>;
  scripts: Map<string, { value: ScriptResource; yamlPath: string; entryPath: string }>;
  diagnostics: Diagnostic[];
}

async function loadFlatResource<T extends { metadata?: { name?: string } }>(
  project: ProjectContext,
  kind: 'agents' | 'rules' | 'hooks' | 'gates',
  id: string,
  schema: SchemaName,
): Promise<{ value: T | null; yamlPath: string; diagnostics: Diagnostic[] }> {
  assertResourceId(id);
  const yamlPath = `xforge/scaffold/${kind}/${id}.yaml`;
  const absolute = await safeResolve(project.root, yamlPath);
  if (!await exists(absolute)) return { value: null, yamlPath, diagnostics: [diagnostic('XFORGE_RESOURCE_MISSING', `Selected ${kind.slice(0, -1)} resource is missing: ${id}`, yamlPath)] };
  const value = await loadYaml<T>(absolute, yamlPath);
  const diagnostics = await validateSchema(schema, value, yamlPath);
  if (value.metadata?.name !== id) diagnostics.push(diagnostic('XFORGE_RESOURCE_NAME_MISMATCH', `Resource metadata.name must equal ${id}.`, yamlPath));
  return { value, yamlPath, diagnostics };
}

export async function loadSelectedResources(project: ProjectContext): Promise<SelectedResources> {
  const diagnostics: Diagnostic[] = [];
  const skills = new Map<string, string>();
  const agents = new Map<string, { value: AgentResource; yamlPath: string; instructionsPath: string; instructions: string }>();
  const rules = new Map<string, { value: RuleResource; yamlPath: string }>();
  const hooks = new Map<string, { value: HookResource; yamlPath: string }>();
  const gates = new Map<string, { value: GateResource; yamlPath: string }>();
  const scripts = new Map<string, { value: ScriptResource; yamlPath: string; entryPath: string }>();

  for (const id of project.manifest.scaffold.skills) {
    assertResourceId(id);
    const directory = `xforge/scaffold/skills/${id}`;
    const skillPath = `${directory}/SKILL.md`;
    const absolute = await safeResolve(project.root, skillPath);
    if (!await exists(absolute)) diagnostics.push(diagnostic('XFORGE_RESOURCE_MISSING', `Selected Skill is missing: ${id}`, skillPath));
    else skills.set(id, await safeResolve(project.root, directory));
  }

  for (const id of project.manifest.scaffold.agents) {
    const loaded = await loadFlatResource<AgentResource>(project, 'agents', id, 'agent');
    diagnostics.push(...loaded.diagnostics);
    if (!loaded.value) continue;
    const instruction = normalizeRelative(loaded.value.spec.instructions, `Agent ${id} instructions`);
    const instructionsPath = `xforge/scaffold/agents/${instruction}`;
    const absolute = await safeResolve(project.root, instructionsPath);
    if (!await exists(absolute)) {
      diagnostics.push(diagnostic('XFORGE_AGENT_INSTRUCTIONS_MISSING', `Agent instructions are missing: ${instruction}`, loaded.yamlPath));
      continue;
    }
    for (const skill of loaded.value.spec.skills) {
      if (!project.manifest.scaffold.skills.includes(skill)) diagnostics.push(diagnostic('XFORGE_AGENT_SKILL_DISABLED', `Agent ${id} references non-enabled Skill ${skill}.`, loaded.yamlPath));
    }
    agents.set(id, { value: loaded.value, yamlPath: loaded.yamlPath, instructionsPath, instructions: await readFile(absolute, 'utf8') });
  }

  for (const id of project.manifest.scaffold.rules) {
    const loaded = await loadFlatResource<RuleResource>(project, 'rules', id, 'rule');
    diagnostics.push(...loaded.diagnostics);
    if (loaded.value) {
      if (loaded.value.spec.constitutionCompatibility === 'conflict') diagnostics.push(diagnostic('XFORGE_CONSTITUTION_RULE_CONFLICT', `Rule ${id} declares a Constitution conflict.`, loaded.yamlPath));
      if (loaded.value.spec.level === 'mandatory' && !loaded.value.spec.gate) diagnostics.push(diagnostic('XFORGE_RULE_NOT_ENFORCED', `Mandatory Rule ${id} has no executable Gate and remains guidance.`, loaded.yamlPath, 'warning'));
      if (loaded.value.spec.gate && !project.manifest.scaffold.gates.includes(loaded.value.spec.gate)) diagnostics.push(diagnostic('XFORGE_RULE_GATE_DISABLED', `Rule ${id} references non-enabled Gate ${loaded.value.spec.gate}.`, loaded.yamlPath));
      rules.set(id, { value: loaded.value, yamlPath: loaded.yamlPath });
    }
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

  return { skills, agents, rules, hooks, gates, scripts, diagnostics };
}
