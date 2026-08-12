import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_FINDINGS_PATH } from '../../src/core/check-findings.js';
import { CONSTITUTION_CHECK_PATH } from '../../src/core/constitution-check.js';
import { checkStructure } from '../../src/core/checker.js';
import { flowArchiveOperation, isStageFlow, loadFlows, resolveChangeState } from '../../src/core/flow-resolver.js';
import { loadProject } from '../../src/core/project-loader.js';
import { changeYaml, checkFindings, constitutionLedger, fixture, runCli, updateYaml, write, xforgeRoot } from '../helpers.js';

// Matches the delta-specs Artifact outline shipped in scaffold/payload/xforge/flows/*.yaml.
const deltaSpec = (name: string): string => [
  '## ADDED Requirements', '',
  `### Requirement: ${name}`, '',
  '#### Scenario: success', '',
  '- **WHEN** the feature is used',
  '- **THEN** it behaves as specified', '',
].join('\n');

describe('Flow artifact graph', () => {
  it('matches the quick, solid, and major golden Stage graphs', async () => {
    const root = await fixture();
    const project = await loadProject(root);
    const { flows, diagnostics } = await loadFlows(project);
    expect(diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    const actual = Object.fromEntries([...flows].sort(([a], [b]) => a.localeCompare(b)).map(([id, flow]) => {
      expect(isStageFlow(flow)).toBe(true);
      if (!isStageFlow(flow)) throw new Error('official flows must use v1alpha2');
      return [id, {
        assuranceLevel: flow.policy.assuranceLevel,
        stages: flow.stages.map((stage) => [stage.id, stage.requires]),
        artifacts: flow.artifacts.map((artifact) => artifact.id),
        gates: flowArchiveOperation(flow).mandatoryGates,
        archiveHandler: flow.terminal.archive.handler,
        approvals: flow.governance?.approvalPolicies.map((policy) => [policy.id, policy.minApprovers, policy.separationOfDuties, policy.providers]) ?? [],
        audit: flow.governance?.audit,
      }];
    }));
    const golden = JSON.parse(await readFile(path.join(xforgeRoot, 'test', 'fixtures', 'golden', 'flows.json'), 'utf8'));
    expect(actual).toEqual(golden);
  });

  it('calculates the next artifact from files rather than hard-coded phases', async () => {
    const root = await fixture();
    const base = 'xforge/changes/tiny-fix';
    await write(root, `${base}/change.yaml`, changeYaml('quick'));
    const project = await loadProject(root);

    expect((await resolveChangeState(project, 'tiny-fix')).state.nextArtifact?.id).toBe('proposal');
    await write(root, `${base}/proposal.md`, '## Why\nA bounded fix.\n');
    expect((await resolveChangeState(project, 'tiny-fix')).state.nextArtifact?.id).toBe('delta-specs');
    await write(root, `${base}/specs/fix/spec.md`, deltaSpec('Fix'));
    const planned = (await resolveChangeState(project, 'tiny-fix')).state;
    expect(planned.nextArtifact).toBeNull();
    expect(planned.apply.ready).toBe(true);
    expect(planned.archive.ready).toBe(false);
    await write(root, `${base}/assurance.md`, '## Completeness\nPassed\n');
    await write(root, `${base}/evidence/verification-receipt.yaml`, 'status: passed\n');
    expect((await resolveChangeState(project, 'tiny-fix')).state.archive.ready).toBe(true);
  });

  it('returns Change schema diagnostics before resolving malformed scope data', async () => {
    const root = await fixture();
    const base = 'xforge/changes/malformed';
    await write(root, `${base}/change.yaml`, [
      'apiVersion: xforge.dev/v1alpha2',
      'kind: Change',
      'change:',
      '  flow: solid',
      '  modules: [root]',
      '  writePaths: [src/**]',
      '',
    ].join('\n'));
    const project = await loadProject(root);

    await expect(resolveChangeState(project, 'malformed')).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'XFORGE_SCHEMA_INVALID',
          path: `${base}/change.yaml`,
        }),
      ]),
    });
  });

  it('requires Major clarification, design, and check before Apply', async () => {
    const root = await fixture();
    const base = 'xforge/changes/major-release';
    await write(root, `${base}/change.yaml`, changeYaml('major'));
    await write(root, `${base}/proposal.md`, '# Proposal');
    await write(root, `${base}/specs/release/spec.md`, deltaSpec('Release'));
    const project = await loadProject(root);
    expect((await resolveChangeState(project, 'major-release')).state.nextArtifact?.id).toBe('clarifications');
    await write(root, `${base}/clarifications.md`, '## Material questions\nResolved\n');
    /* Clarify also owes the machine-decidable ledger; prose alone no longer completes the Stage. */
    expect((await resolveChangeState(project, 'major-release')).state.nextArtifact?.id).toBe('material-questions');
    await write(root, `${base}/evidence/conditions/materialQuestions.yaml`, [
      'condition: materialQuestions',
      'entries:',
      '  - id: q-1',
      '    question: Which store backs the release ledger?',
      '    impact: scope',
      '    decision: Reuse the existing Postgres instance.',
      '    decidedBy: owner@example.test',
      '    decidedAt: 2026-08-11T00:00:00Z',
      '',
    ].join('\n'));
    expect((await resolveChangeState(project, 'major-release')).state.nextArtifact?.id).toBe('design');
    await write(root, `${base}/design.md`, '## Decisions\nSafe rollout\n');
    expect((await resolveChangeState(project, 'major-release')).state.nextArtifact?.id).toBe('check-report');
    await write(root, `${base}/check-report.md`, '## Findings\nNo blockers\n');
    /* Check owes a decidable ledger too; the narrative alone leaves the Stage incomplete. */
    expect((await resolveChangeState(project, 'major-release')).state.nextArtifact?.id).toBe('check-findings');
    await write(root, `${base}/${CHECK_FINDINGS_PATH}`, checkFindings());
    /* And the Constitution has to be answered principle by principle. */
    expect((await resolveChangeState(project, 'major-release')).state.nextArtifact?.id).toBe('constitution-check');
    await write(root, `${base}/${CONSTITUTION_CHECK_PATH}`, await constitutionLedger(root));
    const ready = (await resolveChangeState(project, 'major-release')).state;
    expect(ready.nextArtifact).toBeNull();
    expect(ready.apply.ready).toBe(true);
    expect(ready.archive.ready).toBe(false);
  });

  it('keeps v1alpha1 Artifact Flow projects readable during migration', async () => {
    const root = await fixture();
    const legacyQuick = await readFile(path.join(xforgeRoot, 'test', 'fixtures', 'minimal-project', 'xforge', 'flows', 'quick.yaml'), 'utf8');
    await write(root, 'xforge/flows/quick.yaml', legacyQuick);
    const base = 'xforge/changes/legacy-fix';
    await write(root, `${base}/change.yaml`, changeYaml('quick'));
    await write(root, `${base}/proposal.md`, '## Why\nLegacy project\n');
    await write(root, `${base}/specs/fix/spec.md`, deltaSpec('Fix'));
    const project = await loadProject(root);
    const state = (await resolveChangeState(project, 'legacy-fix')).state;
    expect(state.nextArtifact?.id).toBe('tasks');
    expect(state.apply.ready).toBe(false);
    expect(state.apply.tracks).toBe('tasks.md');
  });
});

describe('Artifact completion', () => {
  it('does not count an empty or whitespace-only Artifact file as done', async () => {
    const root = await fixture();
    const base = 'xforge/changes/tiny-fix';
    await write(root, `${base}/change.yaml`, changeYaml('quick'));
    await write(root, `${base}/proposal.md`, '');
    const project = await loadProject(root);

    const empty = (await resolveChangeState(project, 'tiny-fix')).state;
    expect(empty.artifacts.find((item) => item.id === 'proposal')?.status).toBe('ready');
    expect(empty.nextArtifact?.id).toBe('proposal');

    await write(root, `${base}/proposal.md`, '   \n\n\t\n');
    expect((await resolveChangeState(project, 'tiny-fix')).state.nextArtifact?.id).toBe('proposal');

    await write(root, `${base}/proposal.md`, '## Why\nA bounded fix.\n');
    expect((await resolveChangeState(project, 'tiny-fix')).state.nextArtifact?.id).toBe('delta-specs');
  });

  it('does not count a structurally invalid delta Spec as done', async () => {
    const root = await fixture();
    const base = 'xforge/changes/tiny-fix';
    await write(root, `${base}/change.yaml`, changeYaml('quick'));
    await write(root, `${base}/proposal.md`, '## Why\nA bounded fix.\n');
    await write(root, `${base}/specs/fix/spec.md`, '');
    const project = await loadProject(root);
    expect((await resolveChangeState(project, 'tiny-fix')).state.nextArtifact?.id).toBe('delta-specs');

    // A Requirement without a Scenario is not a usable delta Spec.
    await write(root, `${base}/specs/fix/spec.md`, '## ADDED Requirements\n\n### Requirement: Fix\n');
    const noScenario = (await resolveChangeState(project, 'tiny-fix')).state;
    expect(noScenario.artifacts.find((item) => item.id === 'delta-specs')?.status).toBe('ready');
    expect(noScenario.apply.ready).toBe(false);

    // One valid and one invalid delta Spec still leaves the Artifact unfinished.
    await write(root, `${base}/specs/fix/spec.md`, deltaSpec('Fix'));
    await write(root, `${base}/specs/other/spec.md`, '## ADDED Requirements\n\n### Requirement: Other\n');
    expect((await resolveChangeState(project, 'tiny-fix')).state.apply.ready).toBe(false);

    await write(root, `${base}/specs/other/spec.md`, deltaSpec('Other'));
    const valid = (await resolveChangeState(project, 'tiny-fix')).state;
    expect(valid.artifacts.find((item) => item.id === 'delta-specs')?.status).toBe('done');
    expect(valid.apply.ready).toBe(true);
  });
});

describe('Flow eligibility', () => {
  it('blocks a Change whose classification outgrew its Flow at the first transition', async () => {
    const root = await fixture();
    const base = 'xforge/changes/too-big';
    await write(root, `${base}/change.yaml`, changeYaml('quick', {
      classification: { risk: 'high', security: true, privacy: false, publicApi: false, dataMigration: false },
    }));
    await write(root, `${base}/proposal.md`, '## Why\nA large change on the wrong Flow.\n');
    await write(root, `${base}/specs/fix/spec.md`, deltaSpec('Fix'));
    expect((await runCli(root, ['install'])).code).toBe(0);

    const transition = await runCli(root, ['transition', '--change', 'too-big', '--to', 'apply', '--dry-run']);
    expect(transition.code).toBe(1);
    const codes = transition.json.diagnostics.map((item: any) => item.code);
    expect(codes).toContain('XFORGE_FLOW_TOO_WEAK');
    expect(codes).toContain('XFORGE_FLOW_REQUIRED_POLICY');
  });

  it('lets an eligible Change transition without Flow-policy diagnostics', async () => {
    const root = await fixture();
    const base = 'xforge/changes/tiny-fix';
    await write(root, `${base}/change.yaml`, changeYaml('quick'));
    await write(root, `${base}/proposal.md`, '## Why\nA bounded fix.\n');
    await write(root, `${base}/specs/fix/spec.md`, deltaSpec('Fix'));
    expect((await runCli(root, ['install'])).code).toBe(0);

    const transition = await runCli(root, ['transition', '--change', 'tiny-fix', '--to', 'apply', '--dry-run']);
    const codes = transition.json.diagnostics.map((item: any) => item.code);
    expect(codes).not.toContain('XFORGE_FLOW_TOO_WEAK');
    expect(codes).not.toContain('XFORGE_FLOW_REQUIRED_POLICY');
  });

  it('derives the escalation target from Flow policy on the legacy Artifact Flow path', async () => {
    const root = await fixture();
    const legacyQuick = await readFile(path.join(xforgeRoot, 'test', 'fixtures', 'minimal-project', 'xforge', 'flows', 'quick.yaml'), 'utf8');
    await write(root, 'xforge/flows/quick.yaml', legacyQuick);
    const base = 'xforge/changes/legacy-risky';
    await write(root, `${base}/change.yaml`, changeYaml('quick', {
      classification: { risk: 'high', security: true, privacy: false, publicApi: false, dataMigration: false },
    }));
    await write(root, `${base}/proposal.md`, '## Why\nLegacy project\n');
    await write(root, `${base}/specs/fix/spec.md`, deltaSpec('Fix'));
    const result = await checkStructure(await loadProject(root), 'legacy-risky');
    const codes = result.diagnostics.map((item) => item.code);
    expect(codes).not.toContain('XFORGE_FLOW_PRIME_REQUIRED');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'XFORGE_FLOW_REQUIRED_POLICY',
      message: expect.stringContaining('major'),
    }));
  });
});

describe('Stage Flow governance', () => {
  it('reports a Stage Flow that declares no governance block', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/flows/quick.yaml', (value) => { delete value.governance; });
    const result = await checkStructure(await loadProject(root));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'XFORGE_FLOW_GOVERNANCE_MISSING',
      severity: 'warning',
      path: 'xforge/flows/quick.yaml',
    }));
  });

  it('does not report the shipped Flows as missing governance', async () => {
    const result = await checkStructure(await loadProject(await fixture()));
    expect(result.diagnostics.map((item) => item.code)).not.toContain('XFORGE_FLOW_GOVERNANCE_MISSING');
  });
});

describe('Artifact write destination', () => {
  /* live-engine quick: the model wrote assurance.md and evidence/verification-receipt.yaml to the
     project root, because `generates` is Change-relative and nothing ever said so. */
  it('states the project-relative destination for an Artifact that does not exist yet', async () => {
    const root = await fixture();
    const base = 'xforge/changes/tiny-fix';
    await write(root, `${base}/change.yaml`, changeYaml('quick'));
    const project = await loadProject(root);

    const pending = (await resolveChangeState(project, 'tiny-fix')).state.artifacts.find((item) => item.id === 'proposal');
    expect(pending?.outputPaths).toEqual([]);
    expect(pending?.writePath).toBe(`${base}/proposal.md`);

    const next = await runCli(root, ['state', '--change', 'tiny-fix']);
    const action = next.json.nextActions.find((item: any) => item.action === 'create-artifact');
    expect(action.writes).toEqual([`${base}/proposal.md`]);
  });

  it('keeps a glob Artifact destination anchored to the Change directory', async () => {
    const root = await fixture();
    const base = 'xforge/changes/tiny-fix';
    await write(root, `${base}/change.yaml`, changeYaml('quick'));
    await write(root, `${base}/proposal.md`, '## Why\nA bounded fix.\n');
    const project = await loadProject(root);
    const deltas = (await resolveChangeState(project, 'tiny-fix')).state.artifacts.find((item) => item.id === 'delta-specs');
    expect(deltas?.writePath).toBe(`${base}/specs/**/*.md`);
  });
});
