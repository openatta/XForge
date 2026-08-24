import { describe, expect, it } from 'vitest';
import { documentSections, markerOccurrences, validateArtifactMarkers } from '../../src/core/artifact-markers.js';
import { loadProject } from '../../src/core/project-loader.js';
import { clearVerification, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

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

  /*
   * `validator: outline` is the opt-in that turns a Flow's `outline` from instruction into a
   * reported requirement, for the one Artifact that declares it.
   *
   * No shipped Flow declares it, and that is the point rather than an omission -- see the reasoning
   * in `core/artifact-markers.ts`. These tests therefore declare it the way a project would.
   */
  describe('outline validation', () => {
    /* Marker diagnostics are a different rule with its own tests above, and the shipped Solid Flow
       already declares two markers whose sections this fixture's design.md does not carry. */
    async function outlineDiagnostics(root: string): Promise<Awaited<ReturnType<typeof validateArtifactMarkers>>> {
      return (await markerDiagnostics(root)).filter((item) => item.code === 'XFORGE_ARTIFACT_OUTLINE_SECTION_MISSING');
    }

    async function enforceOutlineOn(root: string, artifactId: string): Promise<void> {
      await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
        flow.artifacts.find((artifact: any) => artifact.id === artifactId).validator = 'outline';
      });
    }

    it('says nothing at all until a Flow opts in', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      /* The fixture's design.md carries `## Decisions` alone, against a six-section outline. */
      expect(await outlineDiagnostics(root)).toEqual([]);
    });

    it('reports each declared section the Artifact does not contain', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await enforceOutlineOn(root, 'design');

      const diagnostics = await outlineDiagnostics(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.code).toBe('XFORGE_ARTIFACT_OUTLINE_SECTION_MISSING');
      expect(diagnostics[0]!.severity).toBe('warning');
      expect(diagnostics[0]!.path).toBe(`xforge/changes/${CHANGE}/design.md`);
      /* Names every missing section, because fixing them one run at a time is the cost this saves. */
      for (const section of ['Context', 'Goals and non-goals', 'Failure modes and compatibility']) {
        expect(diagnostics[0]!.message).toContain(section);
      }
      /* And never blocks: a warning is what keeps this usable on Artifacts written before it. */
      const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
      expect(result.code).toBe(0);
    });

    it('ignores sections the outline does not declare', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await enforceOutlineOn(root, 'design');
      const outline = ['## Context', '## Goals and non-goals', '## Decisions and alternatives',
        '## Failure modes and compatibility', '## Migration and rollback', '## Verification notes'];
      /* Every declared section, plus one the Flow never asked for. An extra section is usually more
         information rather than a defect, and only omission is reported. */
      await write(root, `xforge/changes/${CHANGE}/design.md`,
        `${outline.map((heading) => `${heading}\nText.\n`).join('\n')}\n## Risks\nAn extra section.\n`);

      expect(await outlineDiagnostics(root)).toEqual([]);
    });

    it('says nothing about an Artifact the Change has not written yet', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await enforceOutlineOn(root, 'assurance');
      await (await import('node:fs/promises')).rm(`${root}/xforge/changes/${CHANGE}/assurance.md`);

      expect(await outlineDiagnostics(root)).toEqual([]);
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

/*
 * The XOps failure was not that the marker warning went unreported. It was reported, by `check`, at
 * the Stage that produced the Artifact. It went unread, because the same envelope carried a Gate
 * saying "Structural validation passed." and that is the line a reader stops at. The cost landed at
 * `archive --dry-run`: after the transition, after a human approval.
 */
describe('a passing Gate does not mean a clean check', () => {
  it('says so when Gates pass and the same run reported warnings', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await setMarkers(root, [{ id: 'coverage', section: 'A Section This File Does Not Have', role: 'requirement-coverage' }]);
    expect((await runCli(root, ['install'])).code).toBe(0);

    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    /* The Gate still passes: the marker warning is advisory and promoting it would fail Changes
       written before markers existed. That trade-off is not what this test changes. */
    expect(result.code).toBe(0);
    const gate = (result.json.data.gates as any[]).find((item) => item.id === 'structure');
    expect(gate.status).toBe('passed');
    const diagnostics = result.json.diagnostics as any[];
    expect(diagnostics.some((item) => item.code === 'XFORGE_ARTIFACT_MARKER_SECTION_MISSING')).toBe(true);

    /* What changes is that the run now states the combination out loud, and names what to read. */
    const notice = diagnostics.find((item) => item.code === 'XFORGE_CHECK_PASSED_WITH_WARNINGS');
    expect(notice, JSON.stringify(diagnostics.map((item) => item.code))).toBeTruthy();
    expect(notice.severity).toBe('info');
    expect(notice.message).toContain('XFORGE_ARTIFACT_MARKER_SECTION_MISSING');
    /* And says why fixing it here is cheaper than being told later. */
    expect(notice.message).toContain('archive');
  });

  /* `some(passed)` claimed "Gates passed" on a run where one Gate passed and three failed. A
     failing Gate is already a loud result; nothing is masked, and a cheerful line on a failure is
     worse than silence. */
  it('says nothing when any Gate in the run failed', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await setMarkers(root, [{ id: 'coverage', section: 'A Section This File Does Not Have', role: 'requirement-coverage' }]);
    /* Makes `unit-tests` refuse for want of a declaration, which is a real Gate failure rather than
       a fabricated one — the fixture otherwise declares a passing command for it. */
    await clearVerification(root);
    expect((await runCli(root, ['install'])).code).toBe(0);

    const result = await runCli(root, ['check', '--change', CHANGE, '--all-gates']);
    const gates = result.json.data.gates as any[];
    expect(gates.some((item) => item.status !== 'passed'), JSON.stringify(gates)).toBe(true);
    const codes = (result.json.diagnostics as any[]).map((item) => item.code);
    expect(codes).toContain('XFORGE_ARTIFACT_MARKER_SECTION_MISSING');
    expect(codes).not.toContain('XFORGE_CHECK_PASSED_WITH_WARNINGS');
  });

  /*
   * The notice required at least one Gate to have run, which silenced it at every Stage that
   * declares none — in the shipped `solid` Flow that is design and apply, exactly where an Artifact
   * warning is easiest to walk past. Nothing failing is the condition; having run something is not.
   */
  it('still speaks at a Stage that declares no Gates of its own', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await setMarkers(root, [{ id: 'coverage', section: 'A Section This File Does Not Have', role: 'requirement-coverage' }]);
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure'])).code).toBe(0);
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'design'])).code).toBe(0);

    const result = await runCli(root, ['check', '--change', CHANGE]);
    expect((result.json.data.gates as any[]).length, 'design declares no Gates').toBe(0);
    const codes = (result.json.diagnostics as any[]).map((item) => item.code);
    expect(codes).toContain('XFORGE_ARTIFACT_MARKER_SECTION_MISSING');
    expect(codes).toContain('XFORGE_CHECK_PASSED_WITH_WARNINGS');
  });

  /*
   * Counted every warning in the run, and the run carries project-level ones the Change cannot
   * touch: a stale lock, a Rule this Flow cannot enforce, a Skill that does not cover its Stage.
   * The notice names a count, lists the codes and points at the Change directory, so those arrived
   * as "N things to fix here" that no Change author can fix anywhere — which is the signal erosion
   * the notice exists to prevent, produced by the notice itself.
   */
  it('counts only the warnings that belong to the Change', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await setMarkers(root, []);
    /* A project-level warning and nothing else, and one about a Flow this Change does not even run:
       `quick` left without a governance block. Its path is the Flow file, which is the point — the
       notice locates what it counts inside the Change. */
    await updateYaml(root, 'xforge/flows/quick.yaml', (flow) => { delete flow.governance; });
    expect((await runCli(root, ['install'])).code).toBe(0);

    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    const codes = (result.json.diagnostics as any[]).map((item) => item.code);
    expect(result.code, JSON.stringify(codes)).toBe(0);
    expect(codes, JSON.stringify(codes)).toContain('XFORGE_FLOW_GOVERNANCE_MISSING');
    expect(codes).not.toContain('XFORGE_CHECK_PASSED_WITH_WARNINGS');
  });

  it('stays quiet on a clean run, so the notice keeps meaning something', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    /* Markers cleared to reach a genuinely warning-free run. Worth recording why that is needed:
       the shipped `solid` Flow declares markers in `Verification notes` and `Decisions and
       alternatives`, and a design document that does not happen to use those exact headings warns
       twice — which is the reported problem itself, seen from the inside. */
    await setMarkers(root, []);
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    expect(result.code).toBe(0);
    const codes = (result.json.diagnostics as any[]).map((item) => item.code);
    expect(codes).not.toContain('XFORGE_ARTIFACT_MARKER_SECTION_MISSING');
    expect(codes).not.toContain('XFORGE_CHECK_PASSED_WITH_WARNINGS');
  });
});
