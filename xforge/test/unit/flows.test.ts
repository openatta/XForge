import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { flowArchiveOperation, isStageFlow, loadFlows, resolveChangeState } from '../../src/core/flow-resolver.js';
import { loadProject } from '../../src/core/project-loader.js';
import { changeYaml, fixture, write, xforgeRoot } from '../helpers.js';

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
    await write(root, `${base}/specs/fix/spec.md`, '## ADDED Requirements\n\n### Requirement: Fix\n');
    const planned = (await resolveChangeState(project, 'tiny-fix')).state;
    expect(planned.nextArtifact).toBeNull();
    expect(planned.apply.ready).toBe(true);
    expect(planned.archive.ready).toBe(false);
    await write(root, `${base}/assurance.md`, '## Completeness\nPassed\n');
    await write(root, `${base}/evidence/verification-receipt.yaml`, 'status: passed\n');
    expect((await resolveChangeState(project, 'tiny-fix')).state.archive.ready).toBe(true);
  });

  it('requires Major clarification, design, and check before Apply', async () => {
    const root = await fixture();
    const base = 'xforge/changes/major-release';
    await write(root, `${base}/change.yaml`, changeYaml('major'));
    await write(root, `${base}/proposal.md`, '# Proposal');
    await write(root, `${base}/specs/release/spec.md`, '## ADDED Requirements\n\n### Requirement: Release');
    const project = await loadProject(root);
    expect((await resolveChangeState(project, 'major-release')).state.nextArtifact?.id).toBe('clarifications');
    await write(root, `${base}/clarifications.md`, '## Material questions\nResolved\n');
    expect((await resolveChangeState(project, 'major-release')).state.nextArtifact?.id).toBe('design');
    await write(root, `${base}/design.md`, '## Decisions\nSafe rollout\n');
    expect((await resolveChangeState(project, 'major-release')).state.nextArtifact?.id).toBe('check-report');
    await write(root, `${base}/check-report.md`, '## Findings\nNo blockers\n');
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
    await write(root, `${base}/specs/fix/spec.md`, '## ADDED Requirements\n\n### Requirement: Fix\n');
    const project = await loadProject(root);
    const state = (await resolveChangeState(project, 'legacy-fix')).state;
    expect(state.nextArtifact?.id).toBe('tasks');
    expect(state.apply.ready).toBe(false);
    expect(state.apply.tracks).toBe('tasks.md');
  });
});
