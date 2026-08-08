import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFlows, resolveChangeState } from '../../src/core/flow-resolver.js';
import { loadProject } from '../../src/core/project-loader.js';
import { changeYaml, fixture, write, xforgeRoot } from '../helpers.js';

describe('Flow artifact graph', () => {
  it('matches the quick, solid, and prime golden graphs', async () => {
    const root = await fixture();
    const project = await loadProject(root);
    const { flows, diagnostics } = await loadFlows(project);
    expect(diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    const actual = Object.fromEntries([...flows].sort(([a], [b]) => a.localeCompare(b)).map(([id, flow]) => [id, {
      artifacts: flow.artifacts.map((artifact) => [artifact.id, artifact.requires]),
      apply: flow.operations.apply.requires,
      archive: flow.operations.archive.requires,
      gates: flow.operations.archive.mandatoryGates,
    }]));
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
    expect((await resolveChangeState(project, 'tiny-fix')).state.nextArtifact?.id).toBe('specs');
    await write(root, `${base}/specs/fix/spec.md`, '## ADDED Requirements\n\n### Requirement: Fix\n');
    expect((await resolveChangeState(project, 'tiny-fix')).state.nextArtifact?.id).toBe('tasks');
    await write(root, `${base}/tasks.md`, '- [x] Done\n');
    const complete = (await resolveChangeState(project, 'tiny-fix')).state;
    expect(complete.nextArtifact).toBeNull();
    expect(complete.apply.ready).toBe(true);
    expect(complete.archive.ready).toBe(true);
  });

  it('does not treat a pending Prime approval as complete', async () => {
    const root = await fixture();
    const base = 'xforge/changes/risky-release';
    await write(root, `${base}/change.yaml`, changeYaml('prime'));
    for (const [relative, content] of [
      ['proposal.md', '# Proposal'], ['specs/release/spec.md', '## ADDED Requirements\n\n### Requirement: Release'],
      ['design.md', '# Design'], ['risk-assessment.md', '# Risk'], ['test-plan.md', '# Tests'],
      ['rollout-plan.md', '# Rollout'], ['tasks.md', '- [x] Done'],
      ['approvals/release.md', '## Approval request\n- Status: pending\n- Approver:\n- Decision timestamp:\n'],
    ]) await write(root, `${base}/${relative}`, content);
    const project = await loadProject(root);
    const pending = (await resolveChangeState(project, 'risky-release')).state;
    expect(pending.nextArtifact?.id).toBe('approval');
    expect(pending.apply.ready).toBe(false);

    await write(root, `${base}/approvals/release.md`, '## Approval request\n- Status: approved\n- Approver: release-manager\n- Decision timestamp: 2026-08-08T12:00:00Z\n');
    const approved = (await resolveChangeState(project, 'risky-release')).state;
    expect(approved.apply.ready).toBe(true);
    expect(approved.archive.ready).toBe(true);
  });
});
