import { describe, expect, it } from 'vitest';
import { project } from '../project-builder.js';
import { runCli } from '../helpers.js';

/**
 * A result about one thing must not change with how many things there are.
 *
 * `latestDispatchFor` was correct with one work package and wrong with thirteen: it scanned every
 * package's receipts while holding a known-package set of exactly one, so each *other* package
 * produced an error, and `work-package draft` failed once per package in the plan. A live Major run
 * hand-wrote all thirteen delivery records because of it -- including the half XForge already knew.
 *
 * Every test in the suite used one package, or three. The defect was not subtle; it was outside the
 * only point anybody looked at. So this varies the count and asserts the property directly, which is
 * cheaper than hoping the next such bug happens to be at N = 3.
 */
describe('scale invariance', () => {
  /** Fields that legitimately differ between runs or describe the plan rather than one package. */
  function packageView(state: any, id: string): unknown {
    const entry = state.data.change.workPackages.packages.find((item: any) => item.id === id);
    return { id: entry.id, status: entry.status, missingDependencies: entry.missingDependencies, writePaths: entry.write_paths };
  }

  it('reports one package the same way whether the plan holds 1 or 12', async () => {
    const views: unknown[] = [];
    const diagnostics: string[][] = [];
    for (const count of [1, 12]) {
      const built = await project().flow('solid').packages(count).atStage('apply').build();
      const state = await runCli(built.root, ['state', '--change', built.change]);
      expect(state.code, JSON.stringify(state.json?.diagnostics)).toBe(0);
      views.push(packageView(state.json, 'wp-001'));
      /* Diagnostics about *this* package, which is the half the defect showed up in: the count
         scaled, and every extra one named a package the caller had not asked about. */
      diagnostics.push(state.json.diagnostics
        .filter((item: any) => (item.details as any)?.packageId === 'wp-001')
        .map((item: any) => item.code)
        .sort());
    }
    expect(views[1]).toEqual(views[0]);
    expect(diagnostics[1]).toEqual(diagnostics[0]);
  }, 300_000);

  it('drafts a delivery for one package without reporting the rest of the plan', async () => {
    /*
     * The defect itself, stated as a property rather than as a regression: whatever the plan holds,
     * asking about one execution reports on that execution.
     */
    for (const count of [1, 12]) {
      const built = await project().flow('solid').packages(count).atStage('apply').build();
      for (let index = 1; index <= count; index += 1) {
        const id = `wp-${String(index).padStart(3, '0')}`;
        expect((await runCli(built.root, ['work-package', 'dispatch', '--change', built.change, '--package', id])).code).toBe(0);
      }
      await commit(built.root);

      const draft = await runCli(built.root, ['work-package', 'draft', '--change', built.change, '--package', 'wp-001']);
      expect(draft.code, `${count} packages: ${JSON.stringify(draft.json?.diagnostics)}`).toBe(0);
      expect(draft.json.data.packageId).toBe('wp-001');
      /* Nothing in the envelope may name a package that was not asked about. */
      const named = JSON.stringify(draft.json.diagnostics);
      for (let index = 2; index <= count; index += 1) {
        expect(named, `${count} packages`).not.toContain(`wp-${String(index).padStart(3, '0')}`);
      }
    }
  }, 600_000);

  it('answers `state` at the same Stage identically whatever the plan size', async () => {
    const shapes: string[] = [];
    for (const count of [1, 12]) {
      const built = await project().flow('solid').packages(count).atStage('apply').build();
      const state = await runCli(built.root, ['state', '--change', built.change]);
      const governance = state.json.data.change.governance;
      /* The governance answer is about the Change, not about how the work was divided. A plan size
         that changed which transitions are legal, or which approvals are pending, would be the
         plan leaking into a decision that is not its to make. */
      shapes.push(JSON.stringify({
        stage: governance.currentStage,
        transitions: governance.readyTransitions.map((item: any) => ({ to: item.to, ready: item.ready })),
        approvals: governance.pendingApprovals.map((item: any) => item.policyId),
      }));
    }
    expect(shapes[1]).toBe(shapes[0]);
  }, 300_000);
});

async function commit(root: string): Promise<void> {
  /* A delivery is measured from the commit that dispatched it, so the receipts have to be in one. */
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, 'commit', '-qm', 'dispatch']);
}
