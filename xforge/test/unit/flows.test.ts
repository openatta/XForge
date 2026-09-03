import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_FINDINGS_PATH } from '../../src/core/check-findings.js';
import { CONSTITUTION_CHECK_PATH } from '../../src/core/constitution-check.js';
import { checkStructure } from '../../src/core/checker.js';
import { flowArchiveOperation, isStageFlow, loadFlows, resolveChangeState } from '../../src/core/flow-resolver.js';
import { legalTransitionTargets } from '../../src/core/control-plane.js';
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

  /*
   * The pre-structured `exit` shape validated and then governed nothing.
   *
   * `flow.schema.json` still accepts a bare `<key>: <expected>` map — what `exit` was before
   * `conditions`/`gates`/`approvals`/`auditEvents` — and every reader since expects the structured
   * one: `structuredExit` returns `{}` for it, `check`/`doctor` read `exit.gates` and
   * `exit.approvals` and find nothing, `approve` finds no policy to bind to. A project writing it
   * in its own Flow got a clean load, no doctor finding, and a door the control plane never opened.
   */
  it('refuses a stage exit written in the pre-structured shape', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow: any) => {
      flow.stages.find((stage: any) => stage.id === 'verify').exit = { materialQuestions: 'resolved' };
    });
    const project = await loadProject(root);
    const { diagnostics } = await loadFlows(project);
    const finding = diagnostics.find((item) => item.code === 'XFORGE_FLOW_EXIT_UNSTRUCTURED');
    expect(finding, JSON.stringify(diagnostics)).toBeTruthy();
    expect(finding!.severity).toBe('error');
    /* Names the Stage and the shape to write instead, so the reader is not left to infer either. */
    expect(finding!.message).toContain('verify');
    expect(finding!.message).toContain('conditions');
  });

  /*
   * A `requires` pointing forward, which every existing check walks straight past.
   *
   * `design requires check` is acyclic, so the DFS says nothing. But a Change moves through
   * `stages` in array order, so `check` cannot have run when `design` is reached: every Artifact
   * `design` produces stays blocked on an output that never arrives, `nextArtifact` skips them, and
   * `apply.artifactsReady` can never become true. No Gate, condition or approval is involved, so the author
   * sees a Change that stops advancing and not one diagnostic anywhere.
   */
  it('reports a stage that requires a stage declared after it', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow: any) => {
      flow.stages.find((stage: any) => stage.id === 'design').requires = ['check'];
    });
    const project = await loadProject(root);
    const { diagnostics } = await loadFlows(project);
    const finding = diagnostics.find((item) => item.code === 'XFORGE_FLOW_STAGE_FORWARD_DEPENDENCY');
    expect(finding, JSON.stringify(diagnostics)).toBeTruthy();
    /* Names both ends and the repair, because "which way does the arrow point" is the whole
       question and a bare "invalid dependency" would leave it unanswered. */
    expect(finding!.message).toContain('design');
    expect(finding!.message).toContain('check');
    expect(finding!.message).toContain('reworkTo');
  });

  /* A new diagnostic that fires on the shipped Flows would teach every project to skim past the
     report. All three declare strictly backward `requires`, and this pins that. */
  it('reports nothing of the kind for the Flows the release ships', async () => {
    const root = await fixture();
    const project = await loadProject(root);
    const { diagnostics } = await loadFlows(project);
    expect(diagnostics.filter((item) => item.code === 'XFORGE_FLOW_STAGE_FORWARD_DEPENDENCY')).toEqual([]);
  });

  /*
   * Check is the Stage that holds `check-findings` and `constitution-check`, so a violation found
   * during implementation has to be answerable there. `legalTransitionTargets` offers the next Stage
   * plus `reworkTo` and nothing else, and Major listed `[propose, clarify, design]` — so Apply could
   * not reach Check, and neither could Verify, whose only rework target is Apply. Check was the one
   * Stage a Major Change could never return to, and the workaround was to edit the Design, the one
   * Artifact that did not need to change, in order to walk forward through Check again.
   */
  it('lets every Flow with a Check Stage rework into it from Apply', async () => {
    const root = await fixture();
    const project = await loadProject(root);
    const { flows } = await loadFlows(project);
    const reachable = [...flows]
      .filter(([, flow]) => isStageFlow(flow) && flow.stages.some((stage) => stage.id === 'check'))
      .map(([id, flow]) => {
        if (!isStageFlow(flow)) throw new Error('unreachable');
        const apply = flow.stages.find((stage) => stage.id === 'apply')!;
        return [id, legalTransitionTargets(flow, apply.id).includes('check')];
      });
    /* Both, and the assertion names them so a Flow losing its Check Stage cannot pass by vanishing. */
    expect(reachable.sort()).toEqual([['major', true], ['solid', true]]);
  });

  /* The shipped Flows are the control: all three use the structured shape and must stay silent. */
  it('accepts the structured exit shape the shipped Flows use', async () => {
    const root = await fixture();
    const project = await loadProject(root);
    const { diagnostics } = await loadFlows(project);
    expect(diagnostics.filter((item) => item.code === 'XFORGE_FLOW_EXIT_UNSTRUCTURED')).toEqual([]);
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
    expect(planned.apply.artifactsReady).toBe(true);
    expect(planned.archive.artifactsReady).toBe(false);
    await write(root, `${base}/assurance.md`, '## Completeness\nPassed\n');
    /* Quick answers the Constitution ledger at Verify (it has no Check Stage), and the verification
       receipt is no longer an Artifact — it is a Stage exit condition evaluated against real Gate
       Evidence, which artifact readiness deliberately does not consider. */
    await write(root, `${base}/${CONSTITUTION_CHECK_PATH}`, await constitutionLedger(root));
    expect((await resolveChangeState(project, 'tiny-fix')).state.archive.artifactsReady).toBe(true);
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
    expect(ready.apply.artifactsReady).toBe(true);
    expect(ready.archive.artifactsReady).toBe(false);
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
    expect(state.apply.artifactsReady).toBe(false);
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
    expect(noScenario.apply.artifactsReady).toBe(false);

    // One valid and one invalid delta Spec still leaves the Artifact unfinished.
    await write(root, `${base}/specs/fix/spec.md`, deltaSpec('Fix'));
    await write(root, `${base}/specs/other/spec.md`, '## ADDED Requirements\n\n### Requirement: Other\n');
    expect((await resolveChangeState(project, 'tiny-fix')).state.apply.artifactsReady).toBe(false);

    await write(root, `${base}/specs/other/spec.md`, deltaSpec('Other'));
    const valid = (await resolveChangeState(project, 'tiny-fix')).state;
    expect(valid.artifacts.find((item) => item.id === 'delta-specs')?.status).toBe('done');
    expect(valid.apply.artifactsReady).toBe(true);
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

  it('refuses a Change that says it moves an interface on a Flow that forbids it', async () => {
    /*
     * Quick has no design Stage, so it has nowhere to write a contract delta and no Gate that would
     * read one. A Change that moves an interface on Quick is therefore not a Change that skipped a
     * step -- it is one the Flow has no step for, which is what `contractImpact: forbidden` says.
     *
     * Self-reported, like every other classification key. The classification is what the Change says
     * about itself and nothing compares it with the diff; what this buys is that a Change which
     * *does* say so cannot proceed on a Flow that cannot govern it.
     */
    const root = await fixture();
    const base = 'xforge/changes/quick-interface';
    await write(root, `${base}/change.yaml`, changeYaml('quick', {
      classification: { risk: 'low', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
    }));
    await write(root, `${base}/proposal.md`, '## Why\nA one-line fix that also moves an interface.\n');
    await write(root, `${base}/specs/fix/spec.md`, deltaSpec('Fix'));
    expect((await runCli(root, ['install'])).code).toBe(0);

    const transition = await runCli(root, ['transition', '--change', 'quick-interface', '--to', 'apply', '--dry-run']);
    expect(transition.code).toBe(1);
    const tooWeak = transition.json.diagnostics.find((item: any) => item.code === 'XFORGE_FLOW_TOO_WEAK');
    expect(tooWeak.message).toContain('module contract');
  });

  it('refuses a module contract on the shipped Flows that have nowhere to declare one', async () => {
    /*
     * `quick` was the obvious case and it was not the only one. What decides whether a Flow can carry
     * an interface change is not whether it has a design Stage -- `solid` and `major` both do -- but
     * whether it declares a contract-delta Artifact and merges it. None of the three shipped Flows
     * does either, so a Change classifying itself as moving a module contract on any of them was
     * accepted, collected no delta, merged nothing, and nobody was told.
     *
     * `solid-contract` is the Flow that carries one, and it says so with `contractImpact: allowed`.
     */
    for (const flow of ['quick', 'solid', 'major'] as const) {
      const root = await fixture();
      const base = `xforge/changes/claims-${flow}`;
      await write(root, `${base}/change.yaml`, changeYaml(flow, {
        classification: { risk: 'low', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
      }));
      await write(root, `${base}/proposal.md`, '## Why\nSays it moves an interface.\n');
      await write(root, `${base}/specs/fix/spec.md`, deltaSpec('Fix'));
      const result = await checkStructure(await loadProject(root), `claims-${flow}`);
      const tooWeak = result.diagnostics.find((item) => item.code === 'XFORGE_FLOW_TOO_WEAK');
      expect(tooWeak, `${flow} accepted a module contract it cannot govern`).toBeTruthy();
      expect(tooWeak!.message).toContain('module contract');
    }
  });

  it('does not make a module contract a critical impact, so a contract Flow can still carry one', async () => {
    /*
     * The trap this arrangement exists to avoid. Folding `moduleContract` into the critical-impact
     * set would have made all three checks fire from one edit -- and one of them wrongly: every
     * contract-governed Flow shipped so far declares `criticalImpacts: forbidden`, so the Flow
     * written specifically to govern interface changes would have been the first thing made
     * ineligible to carry one.
     *
     * They are two questions with two keys. This fixture is the shape `solid-contract` has: critical
     * impacts refused, a module contract allowed, and both statements true at once.
     */
    const root = await fixture();
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow: any) => { flow.policy.eligibleWhen.contractImpact = 'allowed'; });
    const base = 'xforge/changes/solid-interface';
    await write(root, `${base}/change.yaml`, changeYaml('solid', {
      classification: { risk: 'medium', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
    }));
    await write(root, `${base}/proposal.md`, '## Why\nAn interface change on the Flow that governs them.\n');
    await write(root, `${base}/specs/fix/spec.md`, deltaSpec('Fix'));
    expect((await runCli(root, ['install'])).code).toBe(0);

    const result = await checkStructure(await loadProject(root), 'solid-interface');
    const codes = result.diagnostics.map((item) => item.code);
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
describe('archive-mandatory Gates', () => {
  /**
   * A Stage added after Verify contributed none of its Gates to the archive re-check and produced
   * no diagnostic -- the set was inferred from the Stage literally named `verify`. The set is
   * declarable now, and the inference says out loud when it is probably not what the author meant.
   */
  async function archiveDiagnostics(mutate: (flow: any) => void): Promise<string[]> {
    const root = await fixture();
    await updateYaml(root, 'xforge/flows/solid.yaml', mutate);
    const project = await loadProject(root);
    const { diagnostics } = await loadFlows(project);
    return diagnostics.map((item) => item.code);
  }

  const withSoak = (flow: any): void => {
    flow.stages.push({ id: 'soak', skill: 'xforge-verify', authority: 'assurance-write', requires: ['verify'], produces: [], gates: ['structure'], reworkTo: ['verify'] });
    flow.terminal.archive.requires = ['soak'];
  };

  it('warns when a Stage after verify declares Gates the inferred archive set will not re-run', async () => {
    expect(await archiveDiagnostics(withSoak)).toContain('XFORGE_FLOW_ARCHIVE_GATES_INFERRED');
  });

  it('says nothing once the Flow declares the set', async () => {
    expect(await archiveDiagnostics((flow: any) => {
      withSoak(flow);
      flow.terminal.archive.gates = ['structure', 'unit-tests'];
    })).not.toContain('XFORGE_FLOW_ARCHIVE_GATES_INFERRED');
  });

  /* And the shipped Flows must stay silent, or the warning is noise on every project. */
  it('says nothing about the Flows the release ships', async () => {
    expect(await archiveDiagnostics(() => {})).not.toContain('XFORGE_FLOW_ARCHIVE_GATES_INFERRED');
  });
});
