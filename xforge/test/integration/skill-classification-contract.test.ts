import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scaffoldPayload, repositoryRoot } from '../helpers.js';
import { workPackagePlanTemplate } from '../../src/core/work-package-template.js';
import { changeTemplate } from '../../src/core/change-template.js';

/**
 * The classification keys the CLI acts on, checked against the thing that offers them.
 *
 * That used to be a fenced YAML block inside `xforge-propose`, because creating a Change was the
 * one step of a governed Flow no Action described. It is now the `create-change` Action's
 * `template`, rendered by `core/change-template.ts` with this project's own default Flow and first
 * module substituted in — so the shape has a single author again, and the Skill can say "fill in
 * the template the Action gives you" instead of carrying a copy that drifts.
 *
 * The assertion follows it. What matters has not changed: a key the schema defines and the offered
 * template omits is a guard nothing can ever trigger.
 *
 * `moduleContract` shipped as a fully wired eligibility key: `change.schema.json` defines it,
 * `checker.ts` reads it, and all three shipped Flows declare `contractImpact: forbidden` with
 * several lines of comment explaining that a Change which *says* it moves an interface must not
 * proceed on a Flow that cannot govern one. None of that can ever fire, because `xforge-propose`
 * is the only Skill that writes `change.yaml` and it never named the key — not in the classification
 * it enumerates, and not in the `change.yaml` template an Agent is told to preserve and fill in.
 *
 * Both halves were individually correct and nothing compared them, which is the same shape as the
 * path defect in `skill-cli-contract.test.ts`. This reads both halves so the next key added to the
 * schema cannot ship as a guard that is unreachable by the Agent expected to trigger it.
 */
describe('Skill and classification contract', () => {
  const SKILLS = ['SKILL.md', 'SKILL_cn.md'] as const;

  it('offers every classification key the schema defines in the create-change template', async () => {
    const schema = JSON.parse(
      await readFile(path.join(repositoryRoot, 'xforge', 'schemas', 'change.schema.json'), 'utf8'),
    ) as { properties: { classification: { properties: Record<string, unknown> } } };
    const keys = Object.keys(schema.properties.classification.properties);
    expect(keys.length).toBeGreaterThan(1);

    const template = changeTemplate('solid', ['root']);
    for (const key of keys) {
      expect(template, `the create-change template omits classification key "${key}", so an Agent following the Action never sets one`).toContain(`${key}:`);
    }
    /* The two fields that come from the project rather than from a placeholder. An Agent accepts
       these unread more often than any other, so a template that hardcoded them would be worse
       than one that left them blank. */
    expect(template).toContain('flow: solid');
    expect(template).toContain('modules: [root]');
  });

  /**
   * The same defect, one file over.
   *
   * `work-package.schema.json` is `additionalProperties: false` over `[apiVersion, kind, packages]`,
   * so a plan missing either header key is refused before any DAG work and `resolveWorkPackages`
   * reports `unusable`. Neither key appeared anywhere an Agent reads -- not in a Skill, not in a
   * Flow `instruction` or `outline`, not in `XFORGE.md` -- while `xforge-apply` said a package
   * contains "only" a list that is the package's fields, not the document's. Every test fixture
   * wrote the header correctly, so the harness could never fail the way an Agent does.
   *
   * This reads the schema and the template together, so a document key added to one and not the
   * other cannot ship.
   */
  it('offers every document key the work-package schema requires in the create-work-packages template', async () => {
    const schema = JSON.parse(
      await readFile(path.join(repositoryRoot, 'xforge', 'schemas', 'work-package.schema.json'), 'utf8'),
    ) as { required: string[]; properties: Record<string, { const?: string }> };
    expect(schema.required).toContain('apiVersion');
    expect(schema.required).toContain('kind');

    const template = workPackagePlanTemplate();
    for (const key of schema.required) {
      expect(template, `the create-work-packages template omits required document key "${key}", so a plan written from it is refused`).toContain(`${key}:`);
    }
    /* The two that are `const` in the schema must match by value, not merely be present: a template
       naming the right key with the wrong value fails exactly as hard as one omitting it. */
    for (const key of ['apiVersion', 'kind']) {
      const literal = schema.properties[key]?.const;
      expect(literal, `${key} is expected to be a const in the schema`).toBeTruthy();
      expect(template).toContain(`${key}: ${literal}`);
    }
  });

  /**
   * A `##` section the Skill names that the Flow's outline does not declare.
   *
   * Step 4 said "write Why, Scope, Non-goals, Actors, Success criteria". Only Major's proposal
   * outline has `## Actors`; on Quick and Solid an Agent following the Skill writes a section its
   * Flow never asked for, and nothing rejects it — `artifact-markers.ts` reports a section that is
   * missing and has no diagnostic for one that is extra. So the Artifact silently diverges from the
   * outline the same Skill calls the contract.
   */
  it('does not name a proposal section only one Flow declares', async () => {
    const flows = ['quick', 'solid', 'major'];
    const outlines = await Promise.all(flows.map(async (flow) => ({
      flow,
      source: await readFile(path.join(scaffoldPayload, 'xforge', 'flows', `${flow}.yaml`), 'utf8'),
    })));
    const universal = ['## Why', '## Scope', '## Non-goals'];
    for (const heading of universal) {
      expect(outlines.every((entry) => entry.source.includes(heading)), `${heading} is not in every proposal outline`).toBe(true);
    }
    /* The section that made this a defect: present in one outline, named unconditionally. */
    expect(outlines.filter((entry) => entry.source.includes('## Actors')).map((entry) => entry.flow)).toEqual(['major']);

    for (const file of SKILLS) {
      const source = await readFile(path.join(scaffoldPayload, 'xforge', 'scaffold', 'skills', 'xforge-propose', file), 'utf8');
      const prose = source.replace(/```yaml\n[\s\S]*?```/g, '');
      expect(prose, `xforge-propose/${file}: names Actors, which only Major's proposal outline declares`)
        .not.toMatch(/Non-goals[^.\n]*Actors/);
    }
  });

  /**
   * A key the template carries but the Skill never explains is a key an Agent fills in with the
   * template's own placeholder value. `moduleContract` is the one that has to be reasoned about
   * rather than copied: answering it wrongly is the only way an interface move reaches a Flow with
   * no Stage to declare it, and the Flow's refusal is what an Agent will be tempted to "fix".
   */
  it('explains what moduleContract means and why its refusal is not an error', async () => {
    for (const file of SKILLS) {
      const source = await readFile(path.join(scaffoldPayload, 'xforge', 'scaffold', 'skills', 'xforge-propose', file), 'utf8');
      const prose = source.replace(/```yaml\n[\s\S]*?```/g, '');
      expect(prose, `xforge-propose/${file}: moduleContract appears only in the template, with nothing saying what it means`).toContain('moduleContract');
      expect(prose, `xforge-propose/${file}: does not name the diagnostic a true moduleContract produces, so the refusal reads as a fault`).toContain('XFORGE_FLOW_TOO_WEAK');
    }
  });
});
