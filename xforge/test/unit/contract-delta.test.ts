import { describe, expect, it } from 'vitest';
import {
  contractDeltaIsValid, isContractDeltaArtifact, parseContractDelta, validateContractDeltaSource,
} from '../../src/core/contract-delta.js';
import type { ArtifactDefinition } from '../../src/types.js';

/*
 * The contract delta is the Spec delta's sibling and is deliberately the same document shape: three
 * operation sections holding `###` blocks keyed by a name, merged at archive into a canonical record.
 * What differs is the key. A Requirement is keyed by a title a person wrote, so the merger has to
 * guess at near misses; a contract element is keyed by an id a machine printed, so an id that does
 * not match is a different element and there is nothing to guess about.
 */
const SHIPPED_OUTLINE = [
  '## ADDED Contract Elements',
  '',
  '### Element: openapi:paths./orders/{id}/cancel.post',
  '',
  '- module: api',
  '- breaking: false',
  '- Cancels an order that has not shipped.',
  '',
  '## MODIFIED Contract Elements',
  '',
  '### Element: openapi:components.schemas.Order.properties.status',
  '',
  '- module: api',
  '- breaking: false',
  '- before: `PENDING | PAID | SHIPPED`',
  '- after: `PENDING | PAID | SHIPPED | CANCELLED`',
  '',
  '## REMOVED Contract Elements',
  '',
  '(none)',
  '',
].join('\n');

const codes = (source: string): string[] =>
  validateContractDeltaSource(source, 'contract-delta.md').map((item) => item.code);

const artifact = (over: Partial<ArtifactDefinition>): ArtifactDefinition =>
  ({ id: 'x', generates: 'x.md', description: '', instruction: '', ...over }) as ArtifactDefinition;

describe('contract delta structure validation', () => {
  it('accepts a delta written to the shipped Artifact outline', () => {
    expect(validateContractDeltaSource(SHIPPED_OUTLINE, 'contract-delta.md')).toEqual([]);
    expect(contractDeltaIsValid(SHIPPED_OUTLINE)).toBe(true);
  });

  it('rejects an empty delta and one with no operation section', () => {
    expect(codes('')).toEqual(['XFORGE_CONTRACT_DELTA_FILE_EMPTY']);
    expect(codes('## Consumer Impact\n\nnothing\n')).toEqual(['XFORGE_CONTRACT_DELTA_NO_SECTION']);
  });

  it('reads "(none)" as an assertion that a section is empty, and a blank section as an omission', () => {
    /*
     * The distinction the whole document rests on. A section left blank is indistinguishable from a
     * section the author never reached, and treating the two alike is what lets a Change archive
     * having said nothing about the interfaces it moved.
     */
    expect(codes('## ADDED Contract Elements\n\n(none)\n')).toEqual([]);
    expect(codes('## ADDED Contract Elements\n\n')).toEqual(['XFORGE_CONTRACT_DELTA_SECTION_EMPTY']);
    expect(codes('## ADDED Contract Elements\n\n(none)\n\n### Element: a:b\n')).toEqual(
      ['XFORGE_CONTRACT_DELTA_SECTION_CONTRADICTORY'],
    );
  });

  it('refuses an element id that is not addressable', () => {
    expect(codes('## ADDED Contract Elements\n\n### Element:\n')).toEqual(['XFORGE_CONTRACT_DELTA_ELEMENT_UNNAMED']);
    /* No kind prefix: `<kind>:<selector>` is what makes an id resolvable to an adapter, and a bare
       selector cannot be looked up in any dialect. */
    expect(codes('## ADDED Contract Elements\n\n### Element: paths./orders.post\n')).toEqual(
      ['XFORGE_CONTRACT_DELTA_ELEMENT_ID_INVALID'],
    );
    expect(codes('## ADDED Contract Elements\n\n### Element: Open API:paths./orders.post\n')).toEqual(
      ['XFORGE_CONTRACT_DELTA_ELEMENT_ID_INVALID'],
    );
  });

  it('refuses the same element twice, in one section or across two', () => {
    const twice = '## ADDED Contract Elements\n\n### Element: a:b\n\n### Element: a:b\n';
    expect(codes(twice)).toEqual(['XFORGE_CONTRACT_DELTA_ELEMENT_DUPLICATE']);
    /*
     * Across sections matters more than within one. "Added and also removed" is not a merge the
     * archive can perform in either order, and the two readings differ: one leaves the element in
     * the baseline and the other leaves it out.
     */
    const contradictory = '## ADDED Contract Elements\n\n### Element: a:b\n\n## REMOVED Contract Elements\n\n### Element: a:b\n';
    expect(codes(contradictory)).toEqual(['XFORGE_CONTRACT_DELTA_ELEMENT_DUPLICATE']);
  });

  it('refuses a duplicated section and an element outside every section', () => {
    expect(codes('## ADDED Contract Elements\n\n### Element: a:b\n\n## ADDED Contract Elements\n\n### Element: c:d\n'))
      .toEqual(['XFORGE_CONTRACT_DELTA_SECTION_DUPLICATE']);
    expect(codes('### Element: a:b\n\n## ADDED Contract Elements\n\n### Element: c:d\n'))
      .toEqual(['XFORGE_CONTRACT_DELTA_ELEMENT_ORPHAN']);
  });

  it('parses each section into the ids it names', () => {
    const parsed = parseContractDelta(SHIPPED_OUTLINE);
    expect(parsed.sections.map((section) => section.operation)).toEqual(['ADDED', 'MODIFIED', 'REMOVED']);
    expect(parsed.sections[0]!.elements.map((element) => element.id)).toEqual(['openapi:paths./orders/{id}/cancel.post']);
    expect(parsed.sections[2]!.elements).toEqual([]);
    expect(parsed.sections[2]!.assertedEmpty).toBe(true);
  });
});

describe('which Artifacts are contract deltas', () => {
  it('takes an explicit validator over the path convention, and never collides with a Spec delta', () => {
    expect(isContractDeltaArtifact(artifact({ validator: 'contract-delta', generates: 'anything.md' }))).toBe(true);
    expect(isContractDeltaArtifact(artifact({ validator: 'spec-delta', generates: 'contracts/http.md' }))).toBe(false);
    expect(isContractDeltaArtifact(artifact({ generates: 'contracts/http.md' }))).toBe(true);
    expect(isContractDeltaArtifact(artifact({ generates: 'specs/orders.md' }))).toBe(false);
    expect(isContractDeltaArtifact(artifact({ generates: 'design.md' }))).toBe(false);
  });
});
