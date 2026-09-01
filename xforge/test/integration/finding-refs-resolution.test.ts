import { describe, expect, it } from 'vitest';
import { evaluateCheckFindings } from '../../src/core/check-findings.js';
import { loadProject } from '../../src/core/project-loader.js';
import { createCompleteSolidChange, fixture, write } from '../helpers.js';

/**
 * Where a Check finding may point.
 *
 * Two ledgers are written in the same Stage by the same Skill, and they took opposite path
 * conventions. `constitution-check` resolves a reference Change-relative and then project-relative,
 * and `xforge-check` documents exactly that — "any path in the repository … Do not confine yourself
 * to Change-local paths". `check-findings` tried one spelling and said nothing about it, so a
 * finding citing `xforge/changes/<id>/design.md` — the form `xforge state` prints, and the form the
 * work-package plan is required to use — was told it "does not exist in this Change" about a file
 * plainly sitting there.
 *
 * The cost is not the warning. A finding has to cite what motivated it, and what motivates a
 * coverage or gate-declaration finding is the immutable acceptance suite or the Manifest — neither
 * reachable Change-relative. Two hand-driven runs each had to reword findings to point somewhere
 * weaker, and both ran the experiment before believing the message.
 */
describe('the paths a Check finding may cite', () => {
  const CHANGE = 'add-feature';

  async function warningsFor(root: string, refs: string[]): Promise<string[]> {
    await write(root, `xforge/changes/${CHANGE}/evidence/check-findings.yaml`, [
      'findings:',
      '  - id: CF-001',
      '    severity: warning',
      '    summary: Something worth recording.',
      `    refs: [${refs.map((ref) => JSON.stringify(ref)).join(', ')}]`,
      '',
    ].join('\n'));
    const result = await evaluateCheckFindings(await loadProject(root, { exactRoot: true }), CHANGE);
    return result.warnings.filter((warning) => warning.includes('CF-001 refs'));
  }

  it('accepts a project-relative path to a file inside the Change', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    expect(await warningsFor(root, [`xforge/changes/${CHANGE}/design.md`])).toEqual([]);
  });

  it('accepts a project file outside the Change, which is what motivates most findings', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    expect(await warningsFor(root, ['xforge/manifest.yaml'])).toEqual([]);
  });

  it('still accepts the Change-relative form', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    expect(await warningsFor(root, ['design.md'])).toEqual([]);
  });

  /**
   * The Requirement a finding is *about* is its most natural citation, and it was refused.
   *
   * `xforge-check` step 5 says a finding carries an "Artifact/Requirement location", and the
   * neighbouring `constitution-check` outline spells `<Requirement id | existing path |
   * gate:<name>>`. This ledger took paths alone, so two hand-driven runs reached for the Requirement
   * — "REQ-X has no automated verification" — were told it does not exist, and reworded the finding
   * to point at something weaker.
   */
  it('accepts a Requirement this Change declares', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    /* The fixture's delta Spec heading; `readRequirements` indexes the heading and its leading id. */
    expect(await warningsFor(root, ['Widget works'])).toEqual([]);
  });

  it('accepts the leading id form of a Requirement heading', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`,
      '## ADDED Requirements\n\n### Requirement: REQ-042 Widget works\n\n#### Scenario: success\n- **WHEN** used\n- **THEN** it works\n');
    expect(await warningsFor(root, ['REQ-042'])).toEqual([]);
  });

  it('still reports a Requirement id no delta Spec declares', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    expect((await warningsFor(root, ['REQ-NOT-DECLARED'])).length).toBe(1);
  });

  it('still reports a path that is nowhere', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    expect((await warningsFor(root, ['no/such/file.md'])).length).toBe(1);
  });
});
