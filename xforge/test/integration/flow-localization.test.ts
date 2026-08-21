import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { documentSections } from '../../src/core/artifact-markers.js';

const payload = path.join(fileURLToPath(new URL('../../..', import.meta.url)), 'scaffold', 'payload', 'xforge', 'flows');
const FLOWS = ['quick', 'solid', 'major'] as const;

async function flow(name: string): Promise<any> {
  return parse(await readFile(path.join(payload, `${name}.yaml`), 'utf8'));
}

/**
 * A Flow ships in two languages, and only one of them may differ.
 *
 * `_cn` variants exist because `markers[].section` locates a section by its heading text, so a
 * Chinese Artifact under an English `outline` resolved no markers at all. The risk that creates is
 * worse than the bug it fixes: a Flow is executable governance, and two copies of `minApprovers`
 * can drift apart with nothing to notice. These tests are what makes that unmergeable — the pair
 * must be identical once the human-facing strings are removed.
 */
describe('Flow localization', () => {
  const localizable = new Set(['description', 'instruction', 'outline', 'section']);

  /** The Flow with every translatable string blanked, so only governance remains. */
  function skeleton(value: unknown, key?: string): unknown {
    if (Array.isArray(value)) return value.map((item) => skeleton(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, skeleton(item, name)]));
    }
    return key && localizable.has(key) ? '<localized>' : value;
  }

  for (const name of FLOWS) {
    it(`${name} and ${name}_cn differ in nothing but their prose`, async () => {
      expect(skeleton(await flow(`${name}_cn`))).toEqual(skeleton(await flow(name)));
    });

    /*
     * The bug itself, pinned in both languages: a marker names a heading, so the two have to move
     * together. Reusing `documentSections` means the test resolves headings exactly the way the
     * marker validator does, rather than by a second regex that could agree by accident.
     */
    it(`${name}_cn keeps every marker pointing at a section its outline declares`, async () => {
      for (const suffix of ['', '_cn']) {
        const definition = await flow(`${name}${suffix}`);
        for (const artifact of definition.artifacts ?? []) {
          for (const marker of artifact.markers ?? []) {
            const sections = documentSections(artifact.outline ?? '');
            expect(
              [...sections.keys()],
              `${name}${suffix}/${artifact.id}/${marker.id} wants "${marker.section}"`,
            ).toContain(marker.section);
          }
        }
      }
    });

    /*
     * Delta-Spec structure is parsed literally by `core/spec-delta.ts` and `core/spec-merger.ts`
     * (`## ADDED Requirements`, `### Requirement:`, `#### Scenario:`). Translating those would not
     * localize anything — it would stop Specs merging.
     */
    it(`${name}_cn leaves machine-parsed Spec structure in English`, async () => {
      const definition = await flow(`${name}_cn`);
      const specs = (definition.artifacts ?? []).find((artifact: any) => artifact.id === 'delta-specs');
      expect(specs.outline).toContain('## ADDED Requirements');
      expect(specs.outline).toContain('### Requirement:');
      expect(specs.outline).toContain('#### Scenario:');
      expect(specs.outline).toContain('**WHEN**');
      expect(specs.outline).toContain('**THEN**');
    });
  }

  /* The ledger skeletons inside `outline` are YAML the CLI parses by key, not prose. */
  it('leaves ledger keys in the outlines untranslated', async () => {
    const solid = await flow('solid_cn');
    const findings = solid.artifacts.find((artifact: any) => artifact.id === 'check-findings');
    for (const key of ['findings:', 'severity:', 'status:', 'reworkTo:', 'resolvedBy:']) {
      expect(findings.outline).toContain(key);
    }
    const principles = solid.artifacts.find((artifact: any) => artifact.id === 'constitution-check');
    for (const key of ['principles:', 'references:', 'justification:', 'approvedBy:']) {
      expect(principles.outline).toContain(key);
    }
  });
});
