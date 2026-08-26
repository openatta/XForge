import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { project } from '../project-builder.js';
import { runCli } from '../helpers.js';

/**
 * The builder tested as a thing tests depend on.
 *
 * A fixture that quietly produces a state the product cannot reach makes every test written on it
 * assert about a world that does not exist, and the failure surfaces as an unrelated test being
 * mysteriously wrong months later. So the properties the other suites will rely on are asserted
 * here, once, against the real CLI: it reaches the Stage it claims, it reaches it by the routes the
 * product offers, and it does the same thing for every Flow rather than for the one its author
 * happened to be working on.
 */
describe('project builder', () => {
  it('reaches the requested Stage in every shipped Flow', async () => {
    for (const [flow, stage] of [['quick', 'verify'], ['solid', 'verify'], ['major', 'check']] as const) {
      const built = await project().flow(flow).atStage(stage).build();
      const state = await runCli(built.root, ['state', '--change', built.change]);
      expect(state.code, `${flow} -> ${stage}: ${JSON.stringify(state.json?.diagnostics)}`).toBe(0);
      expect(state.json.data.change.governance.currentStage, flow).toBe(stage);
    }
  }, 240_000);

  it('walks to ready-to-archive with the closing approval actually collected', async () => {
    const built = await project().flow('quick').atStage('ready-to-archive').build();
    const state = await runCli(built.root, ['state', '--change', built.change]);
    expect(state.json.data.change.governance.currentStage).toBe('ready-to-archive');
    /* Collected, not asserted: an approval this builder recorded by hand would let a test claim a
       Change is archivable when the product would refuse it. */
    expect(state.json.data.change.governance.pendingApprovals).toEqual([]);
    const dryRun = await runCli(built.root, ['archive', '--change', built.change, '--dry-run']);
    expect(dryRun.code, JSON.stringify(dryRun.json?.diagnostics)).toBe(0);
  }, 240_000);

  it('varies the plan size, which is the axis two defects hid behind', async () => {
    for (const count of [1, 5]) {
      const built = await project().flow('solid').packages(count).atStage('apply').build();
      const state = await runCli(built.root, ['state', '--change', built.change]);
      expect(state.json.data.change.workPackages.packages).toHaveLength(count);
    }
  }, 240_000);

  it('varies the declared scope, which is what Rule applicability is compared against', async () => {
    const built = await project().scope(['apps/web/**']).atStage('design').build();
    const state = await runCli(built.root, ['state', '--change', built.change]);
    /* The monorepo shape: the shipped `src/**` Rules reach nothing, and say so. */
    expect(state.json.diagnostics.some((item: any) => item.code === 'XFORGE_RULE_OUT_OF_CHANGE_SCOPE')).toBe(true);
  }, 120_000);

  it('generates each Artifact from the outline the Flow declares, not from a copy of it', async () => {
    const built = await project().flow('solid').build();
    const flow = await readFile(path.join(built.root, 'xforge', 'flows', 'solid.yaml'), 'utf8');
    const design = await readFile(path.join(built.root, 'xforge', 'changes', built.change, 'design.md'), 'utf8');
    /*
     * The property that keeps this from rotting. A hard-coded fixture keeps passing after a Flow
     * changes its outline — it tests the shape the product used to have — and the three helpers this
     * replaces had drifted that way once already.
     */
    for (const heading of flow.split('\n').filter((line) => line.startsWith('      ## ')).map((line) => line.trim())) {
      if (!['## Context', '## Goals and non-goals', '## Decisions and alternatives'].includes(heading)) continue;
      expect(design, heading).toContain(heading);
    }
  }, 120_000);

  it('refuses a Stage the Flow does not declare, rather than walking somewhere else', async () => {
    /* `quick` has no check Stage. A builder that silently stopped early would hand a test a Change
       in a state it did not ask for, and the test would assert about that state without knowing. */
    await expect(project().flow('quick').atStage('check').build()).rejects.toThrow(/declares no Stage check/);
  }, 120_000);
});
