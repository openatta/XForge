import { describe, expect, it } from 'vitest';
import { CHECK_FINDINGS_PATH } from '../../src/core/check-findings.js';
import { readBrief, requirementAnchor, validateTriage } from '../../src/core/brief.js';
import { loadProject } from '../../src/core/project-loader.js';
import { createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

const CHANGE = 'add-feature';

async function brief(root: string, triage?: unknown): Promise<Awaited<ReturnType<typeof readBrief>>> {
  return readBrief(await loadProject(root, { exactRoot: true }), { change: CHANGE, triage });
}

/** Puts a Solid Change at the design Stage, whose exit is the `planning-solid` approval. */
async function atDesignApproval(root: string): Promise<void> {
  await createCompleteSolidChange(root);
  await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
  await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);
}

/** Declares a Requirement-coverage marker on the Solid Flow's design Artifact. */
async function markCoverageSection(root: string, section: string): Promise<void> {
  await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
    const design = flow.artifacts.find((artifact: any) => artifact.id === 'design');
    design.markers = [{ id: 'verification', section, role: 'requirement-coverage' }];
  });
}

const REQUIREMENT_SPEC = [
  '## ADDED Requirements',
  '',
  '### Requirement: REQ-001 Widget renders',
  '',
  '#### Scenario: success',
  '- **WHEN** used',
  '- **THEN** it renders',
  '',
  '### Requirement: REQ-002 Widget refuses bad input',
  '',
  '#### Scenario: failure',
  '- **WHEN** given nonsense',
  '- **THEN** it refuses',
  '',
].join('\n');

describe('xforge brief', () => {
  it('produces nothing at a Stage where no human decides anything', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);

    /* propose declares neither an exit approval nor a blocking finding. Emitting a brief here
       would answer "too much to read" with more to read. */
    const result = await brief(root);
    expect(result.data.decision.applicable).toBe(false);
    expect(result.data.computed).toEqual([]);
    expect(result.data.extracted).toEqual([]);
    expect(result.data.reconciliation).toEqual([]);
    expect(result.data.decision.reason).toContain('no approval');
  });

  it('produces a brief at a Stage exit that a human must approve', async () => {
    const root = await fixture();
    await atDesignApproval(root);

    const result = await brief(root);
    expect(result.data.decision.applicable).toBe(true);
    expect(result.data.stage).toBe('design');
    expect(result.data.decision.approvals.map((entry) => entry.policyId)).toEqual(['planning-solid']);
    expect(result.data.decision.approvals[0]!.minApprovers).toBeGreaterThan(0);
  });

  it('becomes applicable on an open blocker even where the Stage declares no approval', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, [
      'findings:',
      '  - id: F-1',
      '    severity: blocker',
      '    summary: The delta Spec has no failure scenario.',
      '    refs: [specs/widget/spec.md]',
      '    status: open',
      '    reworkTo: propose',
      '',
    ].join('\n'));

    const result = await brief(root);
    expect(result.data.decision.applicable).toBe(true);
    expect(result.data.decision.openBlockers).toEqual(['F-1']);
  });

  /*
   * An item Design routes to the approver rather than back to a Stage was invisible everywhere: it
   * cannot be a blocker (a blocker must name a reworkTo Stage), only blockers are enforced, and the
   * brief listed blockers alone. A live Major run carried two of these through ten approvals whose
   * `reason` all read "good" — the questions were addressed to the approver and never reached one.
   */
  it('lists the open items that name no Stage to return to, with their text', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, [
      'findings:',
      '  - id: CHK-010',
      '    severity: warning',
      '    summary: Accept the single-instance deployment shape, or name the signal that forces a move?',
      '    refs: [design.md]',
      '    status: open',
      '    reworkTo: null',
      '  - id: F-2',
      '    severity: blocker',
      '    summary: Routed back to Propose, not asked of anybody here.',
      '    refs: [design.md]',
      '    status: open',
      '    reworkTo: propose',
      '',
    ].join('\n'));

    const result = await brief(root);
    /* Only the one with nowhere to go back to — the blocker is somebody's to route, not to answer. */
    expect(result.data.decision.awaitingDecision.map((item) => item.id)).toEqual(['CHK-010']);
    /* Carried with its text: an approver who must look up what CHK-010 was will sign without doing so. */
    expect(result.data.decision.awaitingDecision[0]!.summary).toContain('single-instance');
    expect(result.data.decision.openBlockers).toEqual(['F-2']);
  });

  /*
   * The narrow read of this is that an awaiting item no longer summons a brief. The reason it does
   * not is that such an entry is usually a non-blocking note nothing ever resolves, so making it
   * applicable produced a brief at every later Stage — the outcome the gate exists to prevent. What
   * the reported failure actually was is covered above: the briefs approvers already read never
   * mentioned these items.
   */
  it('does not make a brief applicable on its own, but is carried by one that is', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, [
      'findings:',
      '  - id: CHK-011',
      '    severity: suggestion',
      '    summary: Should this discipline become a project Rule?',
      '    refs: [design.md]',
      '',
    ].join('\n'));

    /* A `suggestion` written to the shipped instruction carries no `status` at all — the shape the
       narrowed filter used to drop, and the shape this must keep. */
    const alone = await brief(root);
    expect(alone.data.decision.applicable).toBe(false);

    await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, [
      'findings:',
      '  - id: CHK-011',
      '    severity: suggestion',
      '    summary: Should this discipline become a project Rule?',
      '    refs: [design.md]',
      '  - id: F-9',
      '    severity: blocker',
      '    summary: Something somebody must route.',
      '    refs: [design.md]',
      '    status: open',
      '    reworkTo: propose',
      '',
    ].join('\n'));
    const together = await brief(root);
    expect(together.data.decision.applicable).toBe(true);
    expect(together.data.decision.awaitingDecision.map((item) => item.id)).toEqual(['CHK-011']);
  });

  it('labels every entry with where it came from, and quotes rather than restates', async () => {
    const root = await fixture();
    await atDesignApproval(root);

    const result = await brief(root);
    expect(result.data.computed.every((entry) => entry.provenance === 'computed')).toBe(true);
    expect(result.data.extracted.every((entry) => entry.provenance === 'extracted')).toBe(true);
    /* Extraction is a slice, not a summary: it must carry the file and line it came from, and the
       text must appear in that file verbatim. */
    expect(result.data.extracted.length).toBeGreaterThan(0);
    for (const entry of result.data.extracted) {
      expect(entry.path).toBeTruthy();
      expect(entry.line).toBeGreaterThan(0);
    }
    const decisions = result.data.extracted.find((entry) => entry.label === 'Decisions');
    expect(decisions?.value).toBe('Use a deterministic fixture.');
  });

  it('counts Requirements and Scenarios rather than describing them', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, REQUIREMENT_SPEC);
    await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);

    const result = await brief(root);
    const requirements = result.data.computed.find((entry) => entry.id === 'computed.scale.requirements');
    const scenarios = result.data.computed.find((entry) => entry.id === 'computed.scale.scenarios');
    expect(requirements?.value).toBe(2);
    expect(scenarios?.value).toBe(2);
  });

  it('is byte-identical across runs on one content revision', async () => {
    const root = await fixture();
    await atDesignApproval(root);

    const first = await brief(root);
    const second = await brief(root);
    expect(JSON.stringify(second.data)).toBe(JSON.stringify(first.data));
  });

  describe('reconciliation', () => {
    it('RC-2 reports a Requirement no other Artifact references', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, REQUIREMENT_SPEC);
      await write(root, `xforge/changes/${CHANGE}/design.md`, '## Decisions\nREQ-001 is served by a lookup table.\n');
      await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
      await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);

      const result = await brief(root);
      const unanchored = result.data.reconciliation.filter((entry) => entry.rule === 'RC-2');
      expect(unanchored.map((entry) => entry.refs[0])).toEqual(['REQ-002']);
      expect(unanchored[0]!.code).toBe('XFORGE_BRIEF_REQUIREMENT_UNANCHORED');
    });

    it('RC-3 reports a Requirement missing from the Flow-declared coverage section', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, REQUIREMENT_SPEC);
      await write(root, `xforge/changes/${CHANGE}/design.md`, [
        '## Decisions',
        'REQ-001 and REQ-002 are both served by a lookup table.',
        '',
        '## Verification notes',
        'REQ-001 is covered by a rendering test.',
        '',
      ].join('\n'));
      await markCoverageSection(root, 'Verification notes');
      await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
      await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);

      const result = await brief(root);
      const uncovered = result.data.reconciliation.filter((entry) => entry.rule === 'RC-3');
      /* REQ-001 appears in the coverage section; REQ-002 only appears elsewhere in the file, which
         is exactly the difference this rule exists to state. */
      expect(uncovered.map((entry) => entry.refs[0])).toEqual(['REQ-002']);
    });

    it('RC-3 stays silent when the Flow declares no coverage section', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, REQUIREMENT_SPEC);
      await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
      await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);

      /* A rule that depends on a marker reports nothing when the marker is absent. It never
         guesses which section was meant. */
      const result = await brief(root);
      expect(result.data.reconciliation.filter((entry) => entry.rule === 'RC-3')).toEqual([]);
    });

    it('RC-1 reports a resolved finding whose Requirement never reached the cited file', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, REQUIREMENT_SPEC);
      await write(root, `xforge/changes/${CHANGE}/design.md`, [
        '## Decisions',
        'REQ-001 and REQ-002 are both served by a lookup table.',
        '',
        '## Verification notes',
        'REQ-001 is covered by a rendering test.',
        '',
      ].join('\n'));
      await markCoverageSection(root, 'Verification notes');
      await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, [
        'findings:',
        '  - id: F-5',
        '    severity: warning',
        '    summary: The verification notes omit REQ-002.',
        '    refs: [REQ-002, design.md]',
        '    status: resolved',
        '',
      ].join('\n'));
      await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
      await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);

      const result = await brief(root);
      const unverified = result.data.reconciliation.filter((entry) => entry.rule === 'RC-1');
      expect(unverified).toHaveLength(1);
      expect(unverified[0]!.code).toBe('XFORGE_BRIEF_RESOLUTION_UNVERIFIED');
      expect(unverified[0]!.summary).toContain('F-5');
      expect(unverified[0]!.summary).toContain('Verification notes');
    });

    it('RC-1 stays silent once the resolution actually reached the cited section', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, REQUIREMENT_SPEC);
      await write(root, `xforge/changes/${CHANGE}/design.md`, [
        '## Decisions',
        'REQ-001 and REQ-002 are both served by a lookup table.',
        '',
        '## Verification notes',
        'REQ-001 and REQ-002 each have a test.',
        '',
      ].join('\n'));
      await markCoverageSection(root, 'Verification notes');
      await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, [
        'findings:',
        '  - id: F-5',
        '    severity: warning',
        '    summary: The verification notes omit REQ-002.',
        '    refs: [REQ-002, design.md]',
        '    status: resolved',
        '',
      ].join('\n'));
      await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
      await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);

      const result = await brief(root);
      expect(result.data.reconciliation.filter((entry) => entry.rule === 'RC-1')).toEqual([]);
    });

    it('RC-4 reports a declared gap that no finding answers', async () => {
      const root = await fixture();
      await createCompleteSolidChange(root);
      await write(root, `xforge/changes/${CHANGE}/specs/widget/spec.md`, REQUIREMENT_SPEC);
      await write(root, `xforge/changes/${CHANGE}/design.md`, [
        '## Decisions',
        'REQ-001 and REQ-002 are both served by a lookup table.',
        '',
        '## Open questions',
        '**Deferred to Check:** `REQ-002` does not define the unreachable-backend case.',
        '',
      ].join('\n'));
      await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
        const design = flow.artifacts.find((artifact: any) => artifact.id === 'design');
        design.markers = [{ id: 'deferral', section: 'Open questions', role: 'declared-gap', pattern: ['**Deferred to Check:**'] }];
      });
      await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
      await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);

      const result = await brief(root);
      const gaps = result.data.reconciliation.filter((entry) => entry.rule === 'RC-4');
      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.code).toBe('XFORGE_BRIEF_DECLARED_GAP_UNRESOLVED');
      expect(gaps[0]!.refs).toContain('REQ-002');
    });

    it('RC-5 reports a Constitution citation that resolves to nothing', async () => {
      const root = await fixture();
      await atDesignApproval(root);
      const { CONSTITUTION_CHECK_PATH, constitutionPrinciples } = await import('../../src/core/constitution-check.js');
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const source = await readFile(path.join(root, 'xforge', 'constitution.md'), 'utf8');
      const [first] = constitutionPrinciples(source);
      await write(root, `xforge/changes/${CHANGE}/${CONSTITUTION_CHECK_PATH}`, [
        'principles:',
        `  - principle: ${JSON.stringify(first)}`,
        '    status: compliant',
        '    references: [REQ-404, proposal.md]',
        '',
      ].join('\n'));

      const result = await brief(root);
      const unresolvable = result.data.reconciliation.filter((entry) => entry.rule === 'RC-5');
      expect(unresolvable.map((entry) => entry.refs[0])).toEqual(['REQ-404']);
    });

    /*
     * RC-5 must resolve a reference the same way `constitution-check.ts` does, and that Gate tries
     * the path Change-relative and *then* project-relative. This side did not: it consulted a set
     * built only from the Change's own Artifacts, so a principle citing `xforge/constitution.md` or
     * `xforge/architecture.md` — real files, and the most natural citation an architecture or
     * governance principle has — passed the Gate and was reported here as not existing.
     *
     * Not hypothetical. A live `solid-rework` run's Check Agent cited
     * `test/task-ledger.acceptance.mjs`, the immutable acceptance suite at the repository root, as
     * evidence for a testability principle. That is the right citation; a brief that calls it
     * unresolvable teaches the next Agent to cite something worse.
     */
    it('RC-5 accepts a citation of a real repository path outside the Change directory', async () => {
      const root = await fixture();
      await atDesignApproval(root);
      const { CONSTITUTION_CHECK_PATH, constitutionPrinciples } = await import('../../src/core/constitution-check.js');
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const source = await readFile(path.join(root, 'xforge', 'constitution.md'), 'utf8');
      const [first] = constitutionPrinciples(source);
      /* A file that exists in the repository and nowhere near the Change. */
      await write(root, 'test/acceptance.mjs', 'export const suite = true;\n');
      await write(root, `xforge/changes/${CHANGE}/${CONSTITUTION_CHECK_PATH}`, [
        'principles:',
        `  - principle: ${JSON.stringify(first)}`,
        '    status: compliant',
        '    references: [test/acceptance.mjs, xforge/constitution.md]',
        '',
      ].join('\n'));

      const result = await brief(root);
      expect(result.data.reconciliation.filter((entry) => entry.rule === 'RC-5')).toEqual([]);
    });
  });

  describe('the authored layer', () => {
    it('refuses a triage entry that cites nothing', async () => {
      const anchors = new Set(['computed.scale.requirements']);
      const result = validateTriage([{ label: 'This design looks risky.' }], anchors);
      expect(result.items).toEqual([]);
      expect(result.diagnostics[0]!.code).toBe('XFORGE_BRIEF_UNANCHORED_CLAIM');
    });

    it('refuses a triage entry that cites an id the brief does not contain', async () => {
      const anchors = new Set(['computed.scale.requirements']);
      const result = validateTriage([{ label: 'Look here.', basis: ['computed.invented.fact'] }], anchors);
      expect(result.items).toEqual([]);
      expect(result.diagnostics[0]!.message).toContain('computed.invented.fact');
    });

    it('accepts a triage entry anchored to entries the brief actually produced', async () => {
      const root = await fixture();
      await atDesignApproval(root);

      const result = await brief(root, [{ label: 'Read the scale first.', basis: ['computed.scale.requirements'], note: 'Two Requirements is small.' }]);
      expect(result.diagnostics.filter((entry) => entry.code === 'XFORGE_BRIEF_UNANCHORED_CLAIM')).toEqual([]);
      expect(result.data.authored).toHaveLength(1);
      expect(result.data.authored[0]!.provenance).toBe('authored');
      expect(result.data.authored[0]!.basis).toEqual(['computed.scale.requirements']);
    });

    it('carries no authored entries unless triage was supplied', async () => {
      const root = await fixture();
      await atDesignApproval(root);
      expect((await brief(root)).data.authored).toEqual([]);
    });
  });

  describe('requirement anchors', () => {
    it('cites an id-shaped first token, and the whole heading otherwise', () => {
      expect(requirementAnchor('REQ-042 Widget works')).toBe('REQ-042');
      expect(requirementAnchor('XOPS-STORE-004 写操作失败不留下部分结果')).toBe('XOPS-STORE-004');
      /* "Widget" alone would match unrelated prose and report coverage that does not exist. */
      expect(requirementAnchor('Widget works')).toBe('Widget works');
    });
  });

  describe('the CLI surface', () => {
    it('refuses without --change and reports the brief as a command', async () => {
      const root = await fixture();
      const missing = await runCli(root, ['brief']);
      expect(missing.code).toBe(1);
      expect(missing.json.diagnostics[0].code).toBe('XFORGE_CHANGE_REQUIRED');

      const help = await runCli(root, ['help']);
      expect(Object.keys(help.json.data.commands)).toContain('brief');
    });

    it('renders --text as a brief rather than a JSON dump', async () => {
      const root = await fixture();
      await atDesignApproval(root);

      const result = await runCli(root, ['brief', '--change', CHANGE, '--text']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('WHAT IS BEING DECIDED');
      expect(result.stdout).toContain('COMPUTED');
      expect(result.stdout).toContain('EXTRACTED');
      expect(result.stdout).toContain('NOT COVERED');
      /* The reader must be able to tell a checked line from an asserted one by where it sits. */
      expect(result.stdout.indexOf('COMPUTED')).toBeLessThan(result.stdout.indexOf('EXTRACTED'));
    });

    it('emits one JSON document with the layers separated', async () => {
      const root = await fixture();
      await atDesignApproval(root);

      const result = await runCli(root, ['brief', '--change', CHANGE]);
      expect(result.code).toBe(0);
      expect(result.json.ok).toBe(true);
      expect(result.json.data.computed.length).toBeGreaterThan(0);
      expect(result.json.data.authored).toEqual([]);
      expect(result.json.data.notCovered.length).toBeGreaterThan(0);
    });
  });
});
