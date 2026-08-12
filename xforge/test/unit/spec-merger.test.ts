import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/project-loader.js';
import { planSpecMutations } from '../../src/core/spec-merger.js';
import { changeYaml, fixture, write } from '../helpers.js';

describe('Spec merge planning', () => {
  it('converts a new ADDED delta into a main specification', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/add-widget/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/add-widget/specs/widget/spec.md', '## ADDED Requirements\n\n### Requirement: Widget works\n\n#### Scenario: success\n- **WHEN** used\n- **THEN** it works\n');
    const mutations = await planSpecMutations(await loadProject(root), 'add-widget');
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.path).toBe('xforge/specs/widget/spec.md');
    expect(mutations[0]?.content).toContain('## Requirements');
    expect(mutations[0]?.content).toContain('### Requirement: Widget works');
  });

  it('adds, modifies, removes, and renames requirement blocks deterministically', async () => {
    const root = await fixture();
    await write(root, 'xforge/specs/widget/spec.md', '# Widget\n\n## Purpose\n\nTest.\n\n## Requirements\n\n### Requirement: Keep\n\nOld body.\n\n### Requirement: Remove\n\nRemove me.\n\n### Requirement: Rename me\n\nRename body.\n');
    await write(root, 'xforge/changes/evolve-widget/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/evolve-widget/specs/widget/spec.md', [
      '## ADDED Requirements', '', '### Requirement: Added', '', 'Added body.', '',
      '## MODIFIED Requirements', '', '### Requirement: Keep', '', 'New body.', '',
      '## REMOVED Requirements', '', '### Requirement: Remove', '',
      '## RENAMED Requirements', '', '- FROM: `### Requirement: Rename me`', '- TO: `### Requirement: Renamed`', '',
    ].join('\n'));
    const [mutation] = await planSpecMutations(await loadProject(root), 'evolve-widget');
    expect(mutation?.content).toContain('### Requirement: Keep\n\nNew body.');
    expect(mutation?.content).toContain('### Requirement: Added');
    expect(mutation?.content).toContain('### Requirement: Renamed');
    expect(mutation?.content).not.toContain('### Requirement: Remove');
    expect(mutation?.content).not.toContain('### Requirement: Rename me');
  });

  it('refuses ambiguous full replacement of an existing main Spec', async () => {
    const root = await fixture();
    await write(root, 'xforge/specs/widget/spec.md', '# Existing\n\n## Requirements\n\n### Requirement: Existing\n');
    await write(root, 'xforge/changes/replace-widget/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/replace-widget/specs/widget/spec.md', '# Replacement\n\n## Requirements\n\n### Requirement: Different\n');
    await expect(planSpecMutations(await loadProject(root), 'replace-widget')).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'XFORGE_SPEC_MERGE_CONFLICT' })],
    });
  });

  it('titles a canonical Spec from the capability, for nested and flat delta paths alike', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/two-caps/change.yaml', changeYaml('solid'));
    const delta = (name: string): string => [
      '## ADDED Requirements', '', `### Requirement: ${name} works`, '',
      '#### Scenario: success', '', '- **WHEN** used', '- **THEN** it works', '',
    ].join('\n');
    await write(root, 'xforge/changes/two-caps/specs/greeter.md', delta('Greeter'));
    await write(root, 'xforge/changes/two-caps/specs/task-ledger/spec.md', delta('Ledger'));

    const mutations = await planSpecMutations(await loadProject(root), 'two-caps');
    const titleOf = (suffix: string): string | undefined => mutations
      .find((item) => item.path.endsWith(suffix))?.content?.split('\n')[0];
    /* A flat capability used to inherit its parent directory and come out titled "# specs". */
    expect(titleOf('specs/greeter.md')).toBe('# greeter');
    expect(titleOf('specs/task-ledger/spec.md')).toBe('# task ledger');
  });

  it('refuses a full main Spec for a brand-new capability, matching what check rejects', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/new-widget/change.yaml', changeYaml('solid'));
    /* Archive used to copy this shape through verbatim while `check` rejected it, so a Spec that
       never passed Scenario validation could still land in the canonical set. */
    await write(root, 'xforge/changes/new-widget/specs/gadget/spec.md', '# Gadget\n\n## Requirements\n\n### Requirement: Gadget works\n');
    await expect(planSpecMutations(await loadProject(root), 'new-widget')).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'XFORGE_SPEC_DELTA_NO_SECTION' })],
    });
  });
});
