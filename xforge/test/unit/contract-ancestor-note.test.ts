import { describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/project-loader.js';
import { planContractMutations, validateContractMergeFeasibility } from '../../src/core/contract-merger.js';
import { changeYaml, fixture, write } from '../helpers.js';

const doc = (...lines: string[]): string => `${lines.join('\n')}\n`;

/**
 * An element a delta changes whose recorded ancestor it leaves alone.
 *
 * XForge understands no dialect, so it cannot know that `…schemas.Order.properties.status` is part
 * of `…schemas.Order`. What it can see is that the baseline records both and the delta names one.
 *
 * The gap this closes was measured on a live Change rather than imagined: widening an enum on a
 * child element moved the parent's own canonical digest, and neither `contract-compat` nor
 * `contract-drift` could see it — both are membership arithmetic and the parent is a member before
 * and after. The Agent noticed and wrote its reasoning into the delta unprompted. Nothing prompted
 * it, and nothing would have caught it had it not.
 *
 * Advisory only. Leaving the ancestor as recorded is very often right, and which it is is a
 * judgement about the interface, not about the record.
 */
describe('a declared element whose recorded ancestor is not declared', () => {
  const baseline = doc(
    '# http', '',
    '## Elements', '',
    '### Element: openapi:components.schemas.Order', '', '- module: api', '',
    '### Element: openapi:components.schemas.Order.properties.status', '', '- module: api', '',
    '### Element: openapi:paths./orders.get', '', '- module: api', '',
  );

  async function change(root: string, delta: string): Promise<void> {
    await write(root, 'xforge/contracts/http.md', baseline);
    await write(root, 'xforge/changes/widen/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/widen/contracts/http.md', delta);
  }

  it('says so at check, without refusing the merge', async () => {
    const root = await fixture();
    await change(root, doc(
      '## MODIFIED Contract Elements', '',
      '### Element: openapi:components.schemas.Order.properties.status', '', '- module: api', '',
      'Enum widened by CANCELLED.', '',
    ));
    const project = await loadProject(root);
    const reported = await validateContractMergeFeasibility(project, 'widen');
    const note = reported.find((item) => item.code === 'XFORGE_CONTRACT_ANCESTOR_UNDECLARED');
    expect(note, JSON.stringify(reported.map((item) => item.code))).toBeDefined();
    expect(note!.severity).toBe('warning');
    expect(note!.message).toContain('openapi:components.schemas.Order"');
    /* Advisory: the merge still plans, and archive is not the place to raise the question. */
    expect((await planContractMutations(project, 'widen'))).toHaveLength(1);
  });

  it('says nothing when the delta declares the ancestor too', async () => {
    const root = await fixture();
    await change(root, doc(
      '## MODIFIED Contract Elements', '',
      '### Element: openapi:components.schemas.Order', '', '- module: api', '',
      '### Element: openapi:components.schemas.Order.properties.status', '', '- module: api', '',
    ));
    const reported = await validateContractMergeFeasibility(await loadProject(root), 'widen');
    expect(reported.map((item) => item.code)).not.toContain('XFORGE_CONTRACT_ANCESTOR_UNDECLARED');
  });

  it('does not mistake a dotted sibling for an ancestor', async () => {
    const root = await fixture();
    /* `openapi:paths./orders` is not a recorded element, so `openapi:paths./orders.get` has no
       ancestor here — the dots in a path selector are not containment. */
    await change(root, doc(
      '## MODIFIED Contract Elements', '',
      '### Element: openapi:paths./orders.get', '', '- module: api', '',
    ));
    const reported = await validateContractMergeFeasibility(await loadProject(root), 'widen');
    expect(reported.map((item) => item.code)).not.toContain('XFORGE_CONTRACT_ANCESTOR_UNDECLARED');
  });
});
