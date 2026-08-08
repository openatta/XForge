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
});
