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

  it('still reports a path that is nowhere', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    expect((await warningsFor(root, ['no/such/file.md'])).length).toBe(1);
  });
});
