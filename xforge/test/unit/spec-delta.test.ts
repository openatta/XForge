import { describe, expect, it } from 'vitest';
import { checkStructure } from '../../src/core/checker.js';
import { loadProject } from '../../src/core/project-loader.js';
import { parseRenameEntries, specDeltaIsValid, validateSpecDeltaSource } from '../../src/core/spec-delta.js';
import { changeYaml, fixture, write } from '../helpers.js';

// The authoritative delta Spec shape, copied from the delta-specs Artifact outline shipped in
// scaffold/payload/xforge/flows/{quick,solid,major}.yaml.
const SHIPPED_OUTLINE = [
  '## ADDED Requirements',
  '',
  '### Requirement: REQ-001 Greeter emits a greeting',
  '',
  '#### Scenario: known name',
  '',
  '- **WHEN** the caller supplies a name',
  '- **THEN** the greeting includes that name',
  '',
  '#### Scenario: empty name',
  '',
  '- **WHEN** the caller supplies an empty name',
  '- **THEN** the call is rejected',
  '',
].join('\n');

function codes(source: string): string[] {
  return validateSpecDeltaSource(source, 'delta.md').map((item) => item.code);
}

describe('delta Spec structure validation', () => {
  it('accepts a delta written to the shipped Artifact outline', () => {
    expect(validateSpecDeltaSource(SHIPPED_OUTLINE, 'delta.md')).toEqual([]);
    expect(specDeltaIsValid(SHIPPED_OUTLINE)).toBe(true);
  });

  it('rejects an empty or whitespace-only delta Spec', () => {
    expect(codes('')).toEqual(['XFORGE_SPEC_DELTA_FILE_EMPTY']);
    expect(codes('   \n\n\t\n')).toEqual(['XFORGE_SPEC_DELTA_FILE_EMPTY']);
    expect(specDeltaIsValid('')).toBe(false);
  });

  it('rejects a delta with no operation section', () => {
    const source = '# Widget\n\n## Requirements\n\n### Requirement: Widget works\n\n#### Scenario: ok\n- **WHEN** a\n- **THEN** b\n';
    expect(codes(source)).toEqual(['XFORGE_SPEC_DELTA_NO_SECTION']);
  });

  it('rejects a Requirement with no Scenario in ADDED and MODIFIED sections', () => {
    expect(codes('## ADDED Requirements\n\n### Requirement: Fix\n')).toEqual(['XFORGE_SPEC_DELTA_SCENARIO_MISSING']);
    expect(codes('## MODIFIED Requirements\n\n### Requirement: Fix\n\nNew body.\n')).toEqual(['XFORGE_SPEC_DELTA_SCENARIO_MISSING']);
  });

  it('rejects a Scenario missing WHEN or THEN', () => {
    const noThen = '## ADDED Requirements\n\n### Requirement: Fix\n\n#### Scenario: ok\n- **WHEN** a happens\n';
    const noWhen = '## ADDED Requirements\n\n### Requirement: Fix\n\n#### Scenario: ok\n- **THEN** b happens\n';
    const neither = '## ADDED Requirements\n\n### Requirement: Fix\n\n#### Scenario: ok\n\nSome prose.\n';
    expect(codes(noThen)).toEqual(['XFORGE_SPEC_DELTA_WHEN_THEN_MISSING']);
    expect(codes(noWhen)).toEqual(['XFORGE_SPEC_DELTA_WHEN_THEN_MISSING']);
    expect(validateSpecDeltaSource(neither, 'delta.md')[0]?.details).toMatchObject({ missing: ['WHEN', 'THEN'] });
  });

  it('tolerates plain, italic, and unmarked WHEN and THEN lines', () => {
    const tolerant = [
      '## ADDED Requirements', '',
      '### Requirement: Fix', '',
      '#### Scenario: plain', '',
      '* WHEN: the input is empty',
      '* THEN: the call is rejected', '',
      '#### Scenario: unmarked', '',
      'WHEN the input is long',
      '_THEN_ the call truncates', '',
    ].join('\n');
    expect(validateSpecDeltaSource(tolerant, 'delta.md')).toEqual([]);
  });

  it('rejects unnamed Requirements and Scenarios', () => {
    expect(codes('## ADDED Requirements\n\n### Requirement:\n')).toEqual(['XFORGE_SPEC_DELTA_REQUIREMENT_UNNAMED']);
    expect(codes('## ADDED Requirements\n\n### Requirement: Fix\n\n#### Scenario:\n- **WHEN** a\n- **THEN** b\n'))
      .toEqual(['XFORGE_SPEC_DELTA_SCENARIO_UNNAMED']);
  });

  it('rejects duplicate Requirement names inside one section', () => {
    const source = [
      '## ADDED Requirements', '',
      '### Requirement: Fix', '', '#### Scenario: a', '- **WHEN** a', '- **THEN** b', '',
      '### Requirement: Fix', '', '#### Scenario: c', '- **WHEN** c', '- **THEN** d', '',
    ].join('\n');
    expect(codes(source)).toEqual(['XFORGE_SPEC_DELTA_REQUIREMENT_DUPLICATE']);
  });

  it('rejects an empty or duplicated operation section', () => {
    expect(codes('## ADDED Requirements\n\nNothing here.\n')).toEqual(['XFORGE_SPEC_DELTA_SECTION_EMPTY']);
    const duplicated = `${SHIPPED_OUTLINE}\n## ADDED Requirements\n\n### Requirement: Other\n\n#### Scenario: x\n- **WHEN** a\n- **THEN** b\n`;
    expect(codes(duplicated)).toEqual(['XFORGE_SPEC_DELTA_SECTION_DUPLICATE']);
  });

  it('accepts a REMOVED Requirement with only its header', () => {
    expect(validateSpecDeltaSource('## REMOVED Requirements\n\n### Requirement: Obsolete\n', 'delta.md')).toEqual([]);
  });

  it('requires balanced FROM and TO pairs in RENAMED sections', () => {
    const balanced = '## RENAMED Requirements\n\n- FROM: `### Requirement: Old`\n- TO: `### Requirement: New`\n';
    expect(validateSpecDeltaSource(balanced, 'delta.md')).toEqual([]);
    expect(codes('## RENAMED Requirements\n\n- FROM: `### Requirement: Old`\n')).toEqual(['XFORGE_SPEC_DELTA_RENAME_UNBALANCED']);
    expect(codes('## RENAMED Requirements\n\n- TO: `### Requirement: New`\n')).toEqual(['XFORGE_SPEC_DELTA_RENAME_UNBALANCED']);
    expect(codes('## RENAMED Requirements\n\nNothing.\n')).toEqual(['XFORGE_SPEC_DELTA_SECTION_EMPTY']);
  });

  it('keeps the rename pair set the Spec merger applies', () => {
    const entries = parseRenameEntries('- FROM: `### Requirement: A`\n- FROM: `### Requirement: B`\n- TO: `### Requirement: C`\n');
    expect(entries.pairs).toEqual([{ from: 'B', to: 'C' }]);
    expect(entries.unmatchedFrom).toEqual(['A']);
  });

  it('rejects Requirements written outside any operation section', () => {
    const source = `${SHIPPED_OUTLINE}\n## Notes\n\n### Requirement: Stray\n\n#### Scenario: x\n- **WHEN** a\n- **THEN** b\n`;
    expect(codes(source)).toEqual(['XFORGE_SPEC_DELTA_REQUIREMENT_ORPHAN']);
  });
});

describe('delta Spec structure at check time', () => {
  it('reports a missing Scenario as a check error rather than an archive-time failure', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/add-widget/change.yaml', changeYaml('quick'));
    await write(root, 'xforge/changes/add-widget/proposal.md', '## Why\nA bounded fix.\n');
    await write(root, 'xforge/changes/add-widget/specs/widget/spec.md', '## ADDED Requirements\n\n### Requirement: Widget works\n');
    const result = await checkStructure(await loadProject(root), 'add-widget');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'XFORGE_SPEC_DELTA_SCENARIO_MISSING',
      severity: 'error',
      path: 'xforge/changes/add-widget/specs/widget/spec.md',
    }));
  });

  it('reports a wrongly headed delta Spec at check time', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/add-widget/change.yaml', changeYaml('quick'));
    await write(root, 'xforge/changes/add-widget/specs/widget/spec.md', '## Requirements\n\n### Requirement: Widget works\n');
    const result = await checkStructure(await loadProject(root), 'add-widget');
    expect(result.diagnostics.map((item) => item.code)).toContain('XFORGE_SPEC_DELTA_NO_SECTION');
  });

  it('accepts a well-formed delta Spec at check time', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/add-widget/change.yaml', changeYaml('quick'));
    await write(root, 'xforge/changes/add-widget/proposal.md', '## Why\nA bounded fix.\n');
    await write(root, 'xforge/changes/add-widget/specs/widget/spec.md', SHIPPED_OUTLINE);
    const result = await checkStructure(await loadProject(root), 'add-widget');
    expect(result.diagnostics.filter((item) => item.code.startsWith('XFORGE_SPEC_DELTA_'))).toEqual([]);
  });
});
