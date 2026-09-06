import { describe, expect, it } from 'vitest';
import { hasDeltaSections, parseSpecDelta, validateSpecDeltaSource } from '../../src/core/spec-delta.js';
import { planSpecMutations } from '../../src/core/spec-merger.js';
import { loadProject } from '../../src/core/project-loader.js';
import { changeYaml, fixture, write } from '../helpers.js';

const CHANGE = 'add-feature';

/*
 * A delta Spec documents behaviour, and documenting behaviour means showing it. A fenced block that
 * happens to contain a `## ` heading or a `### Requirement:` line is a payload example, not
 * structure — the contract parser has masked fences since it was written (`core/contract-delta.ts`
 * uses `maskFencedCode` in three places), and the Spec parser, which is the same scheme, did not.
 */
describe('a delta Spec that shows a document inside a fence', () => {
  const fenced = [
    '## ADDED Requirements', '',
    '### Requirement: REQ-1 The tool prints a delta Spec template', '',
    '#### Scenario: template printed',
    '- **WHEN** asked for the template',
    '- **THEN** it prints:', '',
    '```markdown',
    '## ADDED Requirements',
    '',
    '### Requirement: <id> <title>',
    '',
    '#### Scenario: <name>',
    '- **WHEN** <condition>',
    '- **THEN** <result>',
    '```', '',
  ].join('\n');

  it('does not read the fenced example as a second section', () => {
    const parsed = parseSpecDelta(fenced);
    expect(parsed.sections.map((s) => s.operation)).toEqual(['ADDED']);
  });

  it('does not read the fenced example as a second Requirement', () => {
    const parsed = parseSpecDelta(fenced);
    const names = parsed.sections.flatMap((s) => s.requirements.map((r) => r.name));
    expect(names).toEqual(['REQ-1 The tool prints a delta Spec template']);
  });

  it('accepts the document rather than refusing it as duplicated structure', () => {
    const problems = validateSpecDeltaSource(fenced, 'specs/x/spec.md').filter((d) => d.severity === 'error');
    expect(problems.map((d) => d.code)).toEqual([]);
  });

  it('still finds a real section outside a fence', () => {
    expect(hasDeltaSections(fenced)).toBe(true);
    expect(hasDeltaSections('```\n## ADDED Requirements\n```\n')).toBe(false);
  });
});

/*
 * The merger slices by the same headings the parser scans, so it had the same blind spot and a
 * worse consequence: a fenced `## ` ends the section early and a fenced `### Requirement:` becomes
 * a block of its own, so the merge would carry away half a Requirement and record one nobody wrote.
 *
 * This runs the real merge planner against a real project, because an earlier version of this file
 * asserted only that `planSpecMutations` is a function — which holds whether or not the merger was
 * ever fixed. A test that cannot fail is worse than no test: it reports protection that is not
 * there.
 */
describe('merging into a canonical Spec that shows a document inside a fence', () => {
  const FENCED_CANONICAL = [
    '# Widget', '',
    '## Purpose', '', 'What the widget does.', '',
    '## Requirements', '',
    '### Requirement: REQ-1 Prints a delta Spec template', '',
    'It prints exactly:', '',
    '```markdown',
    '## ADDED Requirements',
    '',
    '### Requirement: <id> <title>',
    '',
    '#### Scenario: <name>',
    '- **WHEN** <condition>',
    '- **THEN** <result>',
    '```', '',
    '#### Scenario: template printed',
    '- **WHEN** asked',
    '- **THEN** it prints the block above', '',
    '### Requirement: REQ-2 A second requirement', '',
    '#### Scenario: works',
    '- **WHEN** used',
    '- **THEN** it works', '',
    '## Notes', '', 'Kept after the requirements.', '',
  ].join('\n');

  const MODIFY_SECOND = [
    '## MODIFIED Requirements', '',
    '### Requirement: REQ-2 A second requirement', '',
    '#### Scenario: works',
    '- **WHEN** used again',
    '- **THEN** it still works', '',
  ].join('\n');

  it('modifies the requirement after the fence instead of losing it', async () => {
    const root = await fixture();
    await write(root, 'xforge/specs/widget/spec.md', FENCED_CANONICAL);
    await write(root, `xforge/changes/${CHANGE}/change.yaml`, changeYaml('solid'));
    await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, MODIFY_SECOND);

    /*
     * Before the fix this threw `Cannot modify missing requirement: REQ-2` — the fenced
     * `### Requirement:` line was read as a block boundary, so REQ-2's real heading fell inside
     * what the merger believed was REQ-1's body and could not be found.
     */
    const mutations = await planSpecMutations(await loadProject(root, { exactRoot: true }), CHANGE);
    const merged = mutations.find((entry) => entry.path.endsWith('specs/widget/spec.md'));
    expect(merged, JSON.stringify(mutations.map((entry) => entry.path))).toBeTruthy();

    const content = merged!.content;
    /* The fence survives whole — it is documentation, not structure. */
    expect(content).toContain('```markdown');
    expect(content).toContain('### Requirement: <id> <title>');
    /* The modification landed on the real REQ-2. */
    expect(content).toContain('- **WHEN** used again');
    expect(content).not.toContain('- **WHEN** used\n');
    /* Exactly two Requirements, both real. The fenced heading is inside REQ-1's body, so counting
       headings outside fences is the check that distinguishes structure from illustration. */
    const outsideFences = content.split(/^```[\s\S]*?^```$/gm).join('\n');
    expect([...outsideFences.matchAll(/^### Requirement: (.+)$/gm)].map((m) => m[1])).toEqual([
      'REQ-1 Prints a delta Spec template',
      'REQ-2 A second requirement',
    ]);
    /* And the section after Requirements is still there — a fence must not end the slice early. */
    expect(content).toContain('## Notes');
    expect(content).toContain('Kept after the requirements.');
  });
});
