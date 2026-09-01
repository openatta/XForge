import { describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/project-loader.js';
import { planContractMutations, validateContractMergeFeasibility } from '../../src/core/contract-merger.js';
import { parseContractDelta } from '../../src/core/contract-delta.js';
import { changeYaml, fixture, write } from '../helpers.js';

const doc = (...lines: string[]): string => `${lines.join('\n')}\n`;

/**
 * A contract element that documents its payload by showing it.
 *
 * Every reader of these files scanned structure off a bare `^## ` / `^### ` regex, so the first
 * such line inside a fence ended the section. It was silent, and it lost data: a three-element
 * baseline reported one element, the two it dropped could not be modified — the merger said "the
 * baseline does not record it" about elements plainly in the file — and the refusal's own remedy,
 * declaring them under ADDED, was accepted with no conflict. That writes a second block carrying an
 * id the baseline already held.
 *
 * The Spec parsers share the blindness and are caught by validation rather than by the scan: a
 * Requirement whose `#### Scenario:` fell inside the swallowed region is refused outright. An
 * element has no mandatory sub-block, so nothing caught it here.
 */
describe('markdown headings inside a fence are content, not structure', () => {
  const baseline = doc(
    '# http', '',
    '## Elements', '',
    '### Element: openapi:paths./orders.post', '',
    '- module: api', '',
    'Responds with:', '',
    '```markdown', '## Order', 'id, total', '```', '',
    '### Element: openapi:paths./orders.get', '',
    '- module: api', '',
    '### Element: openapi:paths./orders.delete', '',
    '- module: api', '',
  );

  it('keeps every element of a baseline whose first element shows a markdown payload', async () => {
    const root = await fixture();
    await write(root, 'xforge/contracts/http.md', baseline);
    await write(root, 'xforge/changes/touch-orders/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/touch-orders/contracts/http.md', doc(
      '## MODIFIED Contract Elements', '',
      '### Element: openapi:paths./orders.get', '', '- module: api', '', 'Now paginated.', '',
    ));
    const project = await loadProject(root);

    /* The element is in the file, so modifying it is not a claim about a record that does not exist. */
    expect(await validateContractMergeFeasibility(project, 'touch-orders')).toEqual([]);

    const merged = (await planContractMutations(project, 'touch-orders'))[0]?.content ?? '';
    for (const id of ['orders.post', 'orders.get', 'orders.delete']) {
      expect(merged, `merging dropped openapi:paths./${id}`).toContain(`### Element: openapi:paths./${id}`);
    }
    /* And exactly once each: the ADDED remedy the old refusal suggested is what produced duplicates. */
    expect(merged.match(/^### Element: openapi:paths\.\/orders\.get$/gm)).toHaveLength(1);
  });

  it('reads both elements of a delta whose first one shows a markdown payload', () => {
    const parsed = parseContractDelta(doc(
      '## ADDED Contract Elements', '',
      '### Element: openapi:paths./refunds.post', '', '- module: api', '',
      '```markdown', '## Refund', 'id', '```', '',
      '### Element: openapi:paths./refunds.get', '', '- module: api', '',
    ));
    expect(parsed.sections[0]?.elements.map((element) => element.id))
      .toEqual(['openapi:paths./refunds.post', 'openapi:paths./refunds.get']);
  });

});
