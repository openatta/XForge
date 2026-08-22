import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, StageFlow } from '../types.js';
import { diagnostic } from './errors.js';
import type { SelectedResources } from './resource-loader.js';

/**
 * Whether the Skill a Stage names is told about the gates that Stage declares.
 *
 * A Flow hangs a door on a Stage; the Stage names one Skill; that Skill is what an Agent reads
 * when it arrives there. Nothing checked that the second knew about the first, and twice it did
 * not — both times invisibly, because every existing check looks at whether a reference *resolves*
 * rather than at whether the thing it resolves to covers the job:
 *
 * - Major's `clarify` Stage produces `evidence/conditions/materialQuestions.yaml`, which is also
 *   its only exit condition, while `xforge-clarify`'s Authority read "Do not write ... Evidence"
 *   and its Execution never named the file. The Action authorised the write and the Skill forbade
 *   it, in the same `xforge state` output.
 * - Every Flow's `verify` Stage declares a `builtin: declared` Gate, which only a Manifest
 *   declaration clears, while `xforge-verify` never mentioned `xforge verification declare`.
 *
 * Both were found by hand, over three passes of review. Both are one string comparison away.
 *
 * The rules below are deliberately few and sharp rather than many and approximate. Each one fires
 * on a fact with no legitimate reading — not on a heuristic about whether prose "covers" a topic —
 * because a check that guesses produces the permanent unactionable warning this codebase refuses
 * to ship elsewhere, and a warning nobody can act on teaches people to ignore the ones they can.
 *
 * Reported by `doctor`, over the Flows a project actually uses, and not by `check`. That placement
 * is part of the same principle. This compares a Flow against a Skill: both are project
 * configuration, neither belongs to the Change being checked, and the fix for a shipped Skill is
 * `xforge upgrade-scaffold` — nothing a Change author can do. Run from `check` over every Flow in
 * the project, it put warnings no reader could act on into every command of every project that
 * took a new CLI without upgrading its Scaffold, including warnings about Flows that project never
 * runs. `doctor` is where a project asks about its own configuration, and `usedFlows` is the same
 * scope its unused-Flow and approval-reachability findings already use.
 */

/** Locale variants of one Skill, as `resource-loader` stores its directory. */
async function skillVariants(directory: string): Promise<Array<{ name: string; text: string }>> {
  const variants: Array<{ name: string; text: string }> = [];
  for (const name of ['SKILL.md', 'SKILL_cn.md']) {
    try { variants.push({ name, text: await readFile(path.join(directory, name), 'utf8') }); }
    catch { /* `_cn` is optional; a missing SKILL.md is already XFORGE_SKILL_* from the loader. */ }
  }
  return variants;
}

/**
 * Where the edit goes, said without claiming to know which kind of Skill this is.
 *
 * Every selected Skill lives under `xforge/scaffold/skills/<id>` whatever its origin, so nothing
 * here can tell a shipped Skill from one the project wrote — and the two have different fixes. A
 * shipped Skill is replaced wholesale by `upgrade-scaffold`, so editing it in place is undone by
 * the next upgrade; a project's own Skill is the project's to edit. Saying only "name it in the
 * Skill", which is what these messages used to say, is right for the second and quietly wrong for
 * the first. Naming both routes costs a clause and guesses nothing.
 */
const SKILL_FIX_ROUTE = 'Edit it there if the Skill is this project\'s own; if it ships with XForge, take the upstream fix with `xforge upgrade-scaffold` rather than editing a file the next upgrade replaces.';

/** The variants that do not mention `needle`, by filename, for a message that names them. */
function silentIn(variants: Array<{ name: string; text: string }>, needle: string): string[] {
  return variants.filter((variant) => !variant.text.includes(needle)).map((variant) => variant.name);
}

export async function flowSkillConformanceDiagnostics(
  flow: StageFlow,
  resources: SelectedResources,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const flowPath = `xforge/flows/${flow.metadata.name}.yaml`;
  const generates = new Map(flow.artifacts.map((artifact) => [artifact.id, artifact.generates]));

  for (const stage of flow.stages) {
    const directory = resources.skills.get(stage.skill);
    /* A Skill that is missing or unselected is already reported as a dangling reference; adding a
       second finding for the same cause would report one defect twice. */
    if (!directory) continue;
    const variants = await skillVariants(directory);
    if (variants.length === 0) continue;
    const where = `Flow ${flow.metadata.name} Stage ${stage.id} names Skill ${stage.skill}`;

    /*
     * R1 — an Artifact this Stage produces under `evidence/`.
     *
     * Scoped to `evidence/` rather than applied to every Artifact, and the scope is the whole
     * reason the rule is safe. Every Skill is told never to hand-write Gate Evidence, so an
     * Artifact living in that directory is an exception to an instruction the Agent has already
     * read — it has to be called out by name or the general prohibition wins. That is precisely
     * what happened to the material-questions ledger, and precisely what `xforge-check`'s Authority
     * spends a paragraph preventing for its own two. Artifacts elsewhere (`design.md`,
     * `assurance.md`) carry no such conflict: a Skill may legitimately defer to "the path the
     * Action returned", and flagging that would be the guess this file refuses to make.
     */
    for (const artifactId of stage.produces ?? []) {
      const output = generates.get(artifactId);
      if (!output?.startsWith('evidence/') || output.includes('*')) continue;
      const basename = output.split('/').pop()!;
      const silent = silentIn(variants, basename);
      if (silent.length === 0) continue;
      diagnostics.push(diagnostic(
        'XFORGE_FLOW_SKILL_ARTIFACT_UNNAMED',
        `${where}, and the Stage produces Artifact ${artifactId} at ${output}, which ${silent.join(' and ')} never names. That path is under evidence/, which every Skill is told not to hand-write, so an Agent reading only the Skill has been told the opposite of what the Stage requires. Name the file in the Skill's Authority and say there, as xforge-check does for its own ledgers, that it is an Agent-authored Artifact rather than Gate Evidence. ${SKILL_FIX_ROUTE}`,
        flowPath,
        'warning',
      ));
    }

    /*
     * R2 — a `builtin: declared` Gate. It refuses until the project records a command, and the
     * only supported way to record one is `xforge verification declare`, so a Skill that never
     * names the command owns a Stage it cannot clear.
     */
    for (const gateId of [...new Set([...(stage.gates ?? []), ...(stage.exit?.gates ?? [])])]) {
      if (resources.gates.get(gateId)?.value.spec.builtin !== 'declared') continue;
      const silent = silentIn(variants, 'verification declare');
      if (silent.length === 0) continue;
      diagnostics.push(diagnostic(
        'XFORGE_FLOW_SKILL_DECLARED_GATE_UNCOVERED',
        `${where}, and the Stage declares Gate ${gateId}, whose builtin is "declared" — it refuses until this project records a command, and the only supported way to record one is \`xforge verification declare\`. ${silent.join(' and ')} never names that command, so an Agent blocked there has no route out of the Skill it is holding, and hand-editing xforge/manifest.yaml is both governed by protected-manifest and how a live run made the Manifest unreadable. Name the command in the Skill. ${SKILL_FIX_ROUTE}`,
        flowPath,
        'warning',
      ));
    }

    /*
     * R3 — an exit condition. The key is a literal token the CLI reports back verbatim inside
     * `condition:<key>:<reason>`, so a Skill that never spells it cannot connect the block it is
     * shown to anything it knows how to do.
     */
    for (const key of Object.keys(stage.exit?.conditions ?? {})) {
      const silent = silentIn(variants, key);
      if (silent.length === 0) continue;
      diagnostics.push(diagnostic(
        'XFORGE_FLOW_SKILL_CONDITION_UNNAMED',
        `${where}, and the Stage cannot be left until exit condition "${key}" is satisfied, which ${silent.join(' and ')} never mentions. The CLI reports this block verbatim as \`condition:${key}:<reason>\`, so the Skill has to name it for an Agent to connect the two. Name the condition in the Skill. ${SKILL_FIX_ROUTE}`,
        flowPath,
        'warning',
      ));
    }
  }
  return diagnostics;
}
