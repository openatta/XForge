import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scaffoldPayload, repositoryRoot } from '../helpers.js';

/**
 * The classification keys the CLI acts on, checked against the one Skill that writes them.
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

  /** The `change.yaml` block in `xforge-propose`, which the Skill tells the Agent to preserve. */
  function template(source: string, file: string): string {
    const match = /```yaml\n([\s\S]*?)```/.exec(source);
    expect(match, `${file}: no fenced yaml block found`).toBeTruthy();
    const block = match![1]!;
    expect(block, `${file}: the first yaml block is not the change.yaml template`).toContain('classification:');
    return block;
  }

  it('names every classification key the schema defines in the change.yaml template', async () => {
    const schema = JSON.parse(
      await readFile(path.join(repositoryRoot, 'xforge', 'schemas', 'change.schema.json'), 'utf8'),
    ) as { properties: { classification: { properties: Record<string, unknown> } } };
    const keys = Object.keys(schema.properties.classification.properties);
    expect(keys.length).toBeGreaterThan(1);

    for (const file of SKILLS) {
      const source = await readFile(path.join(scaffoldPayload, 'xforge', 'scaffold', 'skills', 'xforge-propose', file), 'utf8');
      const block = template(source, file);
      for (const key of keys) {
        expect(block, `xforge-propose/${file}: the change.yaml template omits classification key "${key}", so an Agent following it never sets one`).toContain(`${key}:`);
      }
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
