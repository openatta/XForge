import { describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/project-loader.js';
import { planContractMutations, validateContractMergeFeasibility } from '../../src/core/contract-merger.js';
import { changeYaml, fixture, write } from '../helpers.js';

const delta = (...lines: string[]): string => `${lines.join('\n')}\n`;

describe('contract baseline merge planning', () => {
  it('converts a new ADDED delta into a baseline record', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/add-orders/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/add-orders/contracts/http.md', delta(
      '## ADDED Contract Elements', '',
      '### Element: openapi:paths./orders.post', '', '- module: api', '',
    ));
    const mutations = await planContractMutations(await loadProject(root), 'add-orders');
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.path).toBe('xforge/contracts/http.md');
    expect(mutations[0]?.content).toContain('## Elements');
    expect(mutations[0]?.content).toContain('### Element: openapi:paths./orders.post');
    expect(mutations[0]?.change.action).toBe('create');
  });

  it('adds, modifies and removes element blocks deterministically', async () => {
    const root = await fixture();
    await write(root, 'xforge/contracts/http.md', [
      '# http', '', '## Purpose', '', 'Established by archived XForge Changes.', '', '## Elements', '',
      '### Element: openapi:paths./orders.get', '', '- module: api', '',
      '### Element: openapi:paths./orders.delete', '', '- module: api', '',
    ].join('\n'));
    await write(root, 'xforge/changes/evolve/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/evolve/contracts/http.md', delta(
      '## ADDED Contract Elements', '', '### Element: openapi:paths./orders.post', '', '- module: api', '',
      '## MODIFIED Contract Elements', '', '### Element: openapi:paths./orders.get', '', '- module: api', '- now paginated', '',
      '## REMOVED Contract Elements', '', '### Element: openapi:paths./orders.delete', '',
    ));
    const [mutation] = await planContractMutations(await loadProject(root), 'evolve');
    expect(mutation?.content).toContain('### Element: openapi:paths./orders.post');
    expect(mutation?.content).toContain('- now paginated');
    expect(mutation?.content).not.toContain('openapi:paths./orders.delete');
  });

  it('plans nothing at all for a delta that asserts every section is empty', async () => {
    /*
     * The ordinary Change. Most Changes touch no interface, and the delta they write says so with
     * "(none)" in each section — which has to reach archive as no mutation rather than as a rewrite
     * of the baseline to identical bytes, because an identical rewrite still moves the file's mtime
     * and shows up in the archive's own change list as something having happened.
     */
    const root = await fixture();
    await write(root, 'xforge/contracts/http.md', '# http\n\n## Elements\n\n### Element: openapi:paths./orders.get\n\n- module: api\n');
    await write(root, 'xforge/changes/quiet/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/quiet/contracts/http.md', delta(
      '## ADDED Contract Elements', '', '(none)', '',
      '## MODIFIED Contract Elements', '', '(none)', '',
      '## REMOVED Contract Elements', '', '(none)', '',
    ));
    expect(await planContractMutations(await loadProject(root), 'quiet')).toEqual([]);
  });

  it('deletes the record when the last element is removed', async () => {
    const root = await fixture();
    await write(root, 'xforge/contracts/http.md', '# http\n\n## Elements\n\n### Element: openapi:paths./orders.get\n\n- module: api\n');
    await write(root, 'xforge/changes/retire/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/retire/contracts/http.md', delta(
      '## REMOVED Contract Elements', '', '### Element: openapi:paths./orders.get', '',
    ));
    const [mutation] = await planContractMutations(await loadProject(root), 'retire');
    expect(mutation?.content).toBeNull();
    expect(mutation?.change.action).toBe('delete');
  });

  it('refuses a merge that cannot be performed, and says which element', async () => {
    const root = await fixture();
    await write(root, 'xforge/contracts/http.md', '# http\n\n## Elements\n\n### Element: openapi:paths./orders.get\n\n- module: api\n');
    await write(root, 'xforge/changes/bad/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/bad/contracts/http.md', delta(
      '## ADDED Contract Elements', '', '### Element: openapi:paths./orders.get', '',
      '## MODIFIED Contract Elements', '', '### Element: openapi:paths./orders.patch', '',
    ));
    await expect(planContractMutations(await loadProject(root), 'bad')).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'XFORGE_CONTRACT_MERGE_CONFLICT' })],
    });
  });

  it('reports every conflict when asked to check rather than to archive', async () => {
    /*
     * The same merge, run for its refusals. Archive must stop on the first conflict because it is a
     * transaction; check must report all of them, because the whole value of moving the question
     * earlier is sparing the operator one round trip per conflict.
     */
    const root = await fixture();
    await write(root, 'xforge/contracts/http.md', '# http\n\n## Elements\n\n### Element: openapi:paths./orders.get\n\n- module: api\n');
    await write(root, 'xforge/changes/bad/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/bad/contracts/http.md', delta(
      '## ADDED Contract Elements', '', '### Element: openapi:paths./orders.get', '',
      '## MODIFIED Contract Elements', '', '### Element: openapi:paths./orders.patch', '',
      '## REMOVED Contract Elements', '', '### Element: openapi:paths./orders.put', '',
    ));
    const diagnostics = await validateContractMergeFeasibility(await loadProject(root), 'bad');
    expect(diagnostics.map((item) => item.code)).toEqual([
      'XFORGE_CONTRACT_MERGE_CONFLICT', 'XFORGE_CONTRACT_MERGE_CONFLICT', 'XFORGE_CONTRACT_MERGE_CONFLICT',
    ]);
    expect(diagnostics.map((item) => item.message).join(' ')).toContain('openapi:paths./orders.put');
  });

  it('plans no mutation for a file whose merge was refused', async () => {
    /*
     * `content: null` already means "every element was removed, delete the record". A collecting run
     * must not let a refused merge arrive at that same value and be planned as a deletion.
     */
    const root = await fixture();
    await write(root, 'xforge/contracts/http.md', '# http\n\n## Elements\n\n### Element: a:b\n');
    await write(root, 'xforge/changes/bad/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/bad/contracts/http.md', delta(
      '## REMOVED Contract Elements', '', '### Element: a:b', '', '### Element: c:d', '',
    ));
    const diagnostics = await validateContractMergeFeasibility(await loadProject(root), 'bad');
    expect(diagnostics).toHaveLength(1);
  });
});
