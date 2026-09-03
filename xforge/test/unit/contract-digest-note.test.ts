import { describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/project-loader.js';
import { planContractMutations, validateContractMergeFeasibility } from '../../src/core/contract-merger.js';
import { changeYaml, fixture, write } from '../helpers.js';

const doc = (...lines: string[]): string => `${lines.join('\n')}\n`;

/**
 * An element declared as modified whose recorded shape digest did not move.
 *
 * The baseline was a list of ids and prose, so the contract Gates could only do membership
 * arithmetic: adding, removing and renaming an element were decidable, and *modifying* one --
 * widening an enum, changing a field's type, making a field required -- was invisible. That is the
 * most common breaking change there is.
 *
 * `- digest:` gives the project's own enumeration somewhere to record a canonical shape that
 * survives the merge. XForge still understands no dialect and computes no digest; it compares the
 * one the delta carries with the one the baseline already holds, which is the only thing about a
 * modification the record can decide on its own.
 *
 * Optional on both sides, because a project whose adapter computes no digest is not thereby wrong.
 */
describe('a modified element whose digest did not move', () => {
  async function change(root: string, baseline: string, delta: string): Promise<void> {
    await write(root, 'xforge/contracts/http.md', baseline);
    await write(root, 'xforge/changes/widen/change.yaml', changeYaml('solid'));
    await write(root, 'xforge/changes/widen/contracts/http.md', delta);
  }

  const recorded = (digest?: string): string => doc(
    '# http', '',
    '## Elements', '',
    '### Element: openapi:components.schemas.Order', '',
    '- module: api',
    ...(digest ? [`- digest: ${digest}`] : []), '',
  );

  const modified = (digest?: string): string => doc(
    '## MODIFIED Contract Elements', '',
    '### Element: openapi:components.schemas.Order', '',
    '- module: api',
    ...(digest ? [`- digest: ${digest}`] : []), '',
    'Enum widened by CANCELLED.', '',
  );

  it('says so, and still lets the merge plan', async () => {
    const root = await fixture();
    await change(root, recorded('sha256:abc123'), modified('sha256:abc123'));
    const project = await loadProject(root);
    const reported = await validateContractMergeFeasibility(project, 'widen');
    const note = reported.find((item) => item.code === 'XFORGE_CONTRACT_MODIFIED_DIGEST_UNCHANGED');
    expect(note, JSON.stringify(reported.map((item) => item.code))).toBeDefined();
    expect(note!.severity).toBe('warning');
    /* Names the element and the digest, because "which one, and what value" is the whole question. */
    expect(note!.message).toContain('openapi:components.schemas.Order');
    expect(note!.message).toContain('sha256:abc123');
    /* Advisory: a record that disagrees with itself is worth a sentence, not a refused archive. */
    expect(await planContractMutations(project, 'widen')).toHaveLength(1);
  });

  it('says nothing when the digest moved', async () => {
    const root = await fixture();
    await change(root, recorded('sha256:abc123'), modified('sha256:def456'));
    const reported = await validateContractMergeFeasibility(await loadProject(root), 'widen');
    expect(reported.map((item) => item.code)).not.toContain('XFORGE_CONTRACT_MODIFIED_DIGEST_UNCHANGED');
  });

  it('says nothing when either side records no digest, which is the supported case', async () => {
    for (const [baseline, delta] of [
      [recorded('sha256:abc123'), modified()],
      [recorded(), modified('sha256:abc123')],
      [recorded(), modified()],
    ] as const) {
      const root = await fixture();
      await change(root, baseline, delta);
      const reported = await validateContractMergeFeasibility(await loadProject(root), 'widen');
      expect(reported.map((item) => item.code)).not.toContain('XFORGE_CONTRACT_MODIFIED_DIGEST_UNCHANGED');
    }
  });
});
