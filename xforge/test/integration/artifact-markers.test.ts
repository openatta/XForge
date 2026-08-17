import { describe, expect, it } from 'vitest';
import { documentSections, markerOccurrences, validateArtifactMarkers } from '../../src/core/artifact-markers.js';
import { loadProject } from '../../src/core/project-loader.js';
import { createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

const CHANGE = 'add-feature';

async function markerDiagnostics(root: string): Promise<Awaited<ReturnType<typeof validateArtifactMarkers>>> {
  return validateArtifactMarkers(await loadProject(root, { exactRoot: true }), CHANGE);
}

async function setMarkers(root: string, markers: unknown[]): Promise<void> {
  await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
    flow.artifacts.find((artifact: any) => artifact.id === 'design').markers = markers;
  });
}

describe('Artifact markers', () => {
  describe('section slicing', () => {
    it('keeps a Requirement heading inside the section it belongs to', () => {
      const parsed = documentSections([
        '## Decisions',
        'We chose A.',
        '',
        '### Requirement: REQ-001 not a section',
        'Still inside Decisions.',
        '',
        '## Verification notes',
        'REQ-001 has a test.',
      ].join('\n'));

      expect([...parsed.keys()]).toEqual(['Decisions', 'Verification notes']);
      /* `###` must not close the `##` it sits under, or every rule scoped to a section would read
         a truncated body and report absences that are not real. */
      expect(parsed.get('Decisions')!.body).toContain('Still inside Decisions.');
      expect(parsed.get('Verification notes')!.line).toBe(7);
    });

    it('reports each occurrence at its line in the whole document', () => {
      const parsed = documentSections([
        '## Decisions',
        'We chose A.',
        '**Rejected alternative:** B was cheaper but leaks credentials.',
        '**被否决的替代方案：** C needs a second store.',
      ].join('\n'));

      const occurrences = markerOccurrences(parsed.get('Decisions')!, {
        id: 'rejected-alternative',
        section: 'Decisions',
        role: 'decision-alternative',
        pattern: ['**Rejected alternative:', '**被否决的替代方案：'],
      });

      /* One Flow governs projects writing either language, so a marker carries both spellings. */
      expect(occurrences.map((entry) => entry.line)).toEqual([3, 4]);
      expect(occurrences[0]!.text).toContain('B was cheaper');
      /* Adjacent entries do not swallow each other. */
      expect(occurrences[0]!.text).not.toContain('second store');
      expect(occurrences[1]!.text).toContain('C needs a second store');
    });

    it('carries a wrapped entry to the end of its paragraph', () => {
      const parsed = documentSections([
        '## Decisions',
        '**Rejected alternative:** signed stateless tokens. Cheaper to verify and needs no',
        'store, which is exactly why the rejection needs writing down: they cannot be',
        'revoked before expiry.',
        '',
        'A later paragraph that is not part of the entry.',
      ].join('\n'));

      const [occurrence] = markerOccurrences(parsed.get('Decisions')!, {
        id: 'rejected-alternative',
        section: 'Decisions',
        role: 'decision-alternative',
        pattern: ['**Rejected alternative:'],
      });

      /* A quote cut at the line break still reads like a finished sentence, which makes it worse
         than no quote: "Cheaper to verify and needs no" reverses the author's actual point. */
      expect(occurrence!.text).toContain('they cannot be revoked before expiry.');
      expect(occurrence!.text).not.toContain('A later paragraph');
    });
  });

  describe('structure validation', () => {
    it('warns rather than fails when a declared section is absent', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await setMarkers(root, [{ id: 'verification-coverage', section: 'Verification notes', role: 'requirement-coverage' }]);

      /* The shipped fixture's design.md has only `## Decisions`. Failing here would reject Changes
         that were valid before markers existed, for a shape nothing had required of them. */
      const diagnostics = await markerDiagnostics(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.code).toBe('XFORGE_ARTIFACT_MARKER_SECTION_MISSING');
      expect(diagnostics[0]!.severity).toBe('warning');

      const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
      expect(result.code).toBe(0);
    });

    it('fails the structure Gate when the Flow required a minimum the Artifact does not meet', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await write(root, `xforge/changes/${CHANGE}/design.md`, '## Decisions\nWe chose A and wrote down nothing we rejected.\n');
      await setMarkers(root, [{
        id: 'rejected-alternative',
        section: 'Decisions',
        role: 'decision-alternative',
        pattern: ['**Rejected alternative:'],
        minOccurrences: 1,
      }]);

      const diagnostics = await markerDiagnostics(root);
      expect(diagnostics.map((entry) => entry.code)).toEqual(['XFORGE_ARTIFACT_MARKER_UNDERPOPULATED']);
      /* Unlike the outline, a minimum is something a project opted into, so it blocks. */
      expect(diagnostics[0]!.severity).toBe('error');

      const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
      expect(result.code).toBe(1);
      expect(result.json.diagnostics.map((entry: any) => entry.code)).toContain('XFORGE_ARTIFACT_MARKER_UNDERPOPULATED');
    });

    it('passes once the required entries are present', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await write(root, `xforge/changes/${CHANGE}/design.md`, [
        '## Decisions',
        'We chose A.',
        '**Rejected alternative:** B was cheaper but leaks credentials.',
        '',
      ].join('\n'));
      await setMarkers(root, [{
        id: 'rejected-alternative',
        section: 'Decisions',
        role: 'decision-alternative',
        pattern: ['**Rejected alternative:'],
        minOccurrences: 1,
      }]);

      expect(await markerDiagnostics(root)).toEqual([]);
      expect((await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure'])).code).toBe(0);
    });

    it('says nothing about an Artifact that has not been written yet', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      const { rm } = await import('node:fs/promises');
      const path = await import('node:path');
      await rm(path.join(root, 'xforge', 'changes', CHANGE, 'design.md'));
      await setMarkers(root, [{
        id: 'rejected-alternative',
        section: 'Decisions',
        role: 'decision-alternative',
        pattern: ['**Rejected alternative:'],
        minOccurrences: 1,
      }]);

      /* When an Artifact is due is the Flow's Stage requirements' business, not this rule's. */
      expect(await markerDiagnostics(root)).toEqual([]);
    });
  });

  describe('the shipped Flows', () => {
    it('declare a Requirement-coverage section without requiring a minimum', async () => {
      const root = await fixture();
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const { parse } = await import('yaml');

      for (const [name, artifact, section] of [
        ['quick', 'assurance', 'Completeness'],
        ['solid', 'design', 'Verification notes'],
        ['major', 'design', 'Test strategy'],
      ] as const) {
        const flow = parse(await readFile(path.join(root, 'xforge', 'flows', `${name}.yaml`), 'utf8'));
        const markers = flow.artifacts.find((entry: any) => entry.id === artifact).markers;
        const coverage = markers.find((entry: any) => entry.role === 'requirement-coverage');
        expect(coverage.section, `${name}/${artifact}`).toBe(section);
        /* Shipping a minimum would fail every Change written before markers existed. */
        expect(coverage.minOccurrences, `${name}/${artifact}`).toBeUndefined();
      }
    });

    it('carry both scaffold languages in every entry pattern', async () => {
      const root = await fixture();
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const { parse } = await import('yaml');

      for (const name of ['solid', 'major'] as const) {
        const flow = parse(await readFile(path.join(root, 'xforge', 'flows', `${name}.yaml`), 'utf8'));
        for (const artifact of flow.artifacts) {
          for (const marker of artifact.markers ?? []) {
            if (!marker.pattern) continue;
            /* A Flow is single-sourced while the prose it governs is localized, so a pattern that
               named one language would silently stop locating anything in the other. */
            expect(marker.pattern.length, `${name}/${artifact.id}/${marker.id}`).toBeGreaterThanOrEqual(2);
          }
        }
      }
    });
  });
});
