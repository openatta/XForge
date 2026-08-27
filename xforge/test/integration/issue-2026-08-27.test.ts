import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { project } from '../project-builder.js';
import { runCli, updateYaml, write } from '../helpers.js';

const run = promisify(execFile);

/**
 * The third field report from a governed delivery, closed one case at a time.
 *
 * Its own summary names the shape they share: *the diagnostic says something slightly different
 * from what it actually checked*. That is worse than a wrong answer, because the reader builds on
 * it — this report records two occasions where a correct-looking result produced a written-down
 * conclusion that was false, and one where a name the CLI itself printed was rejected as an
 * argument. None of these is a wrong decision. Each is a sentence that did not describe the
 * decision it accompanied.
 */
describe('field report 2026-08-27', () => {
  const PACKAGE = 'wp-001';

  /**
   * A dispatched, delivered, committed package — the state every delivery check reads.
   *
   * Committed deliberately: the whole subject here is what happens to a delivery record once HEAD
   * moves past the range it declares, and that starts with the record's own commit.
   */
  async function delivered(): Promise<{ root: string; change: string }> {
    const built = await project().flow('solid').packages(1).atStage('apply').build();
    expect((await runCli(built.root, ['work-package', 'dispatch', '--change', built.change, '--package', PACKAGE])).code).toBe(0);
    await commit(built.root, 'dispatch');
    await write(built.root, `src/${PACKAGE}/widget.ts`, 'export const widget = true;\n');
    await commit(built.root, 'work');

    const drafted = await runCli(built.root, ['work-package', 'draft', '--change', built.change, '--package', PACKAGE]);
    expect(drafted.code, JSON.stringify(drafted.json?.diagnostics)).toBe(0);
    await writeDelivery(built.root, drafted.json.data);
    await commit(built.root, 'delivery');
    return { root: built.root, change: built.change };
  }

  it('says a delivery verdict is about the recorded range once the plan has moved past it', async () => {
    const { root, change } = await delivered();

    /*
     * The record's own commit already moved HEAD past `head_commit`, and that must stay silent: it
     * happens on every delivery by construction, and a notice that fires every time is one nobody
     * reads by the second week.
     */
    const settled = await runCli(root, ['check', '--change', change, '--gate', 'structure']);
    expect(settled.json.diagnostics.map((item: any) => item.code)).not.toContain('XFORGE_WORK_PACKAGE_DELIVERY_RECORD_STALE');

    /*
     * Then the reported sequence: a write escape is corrected by widening `write_paths`, and
     * `check` is re-run to confirm. It answers about `base_commit...head_commit`, which is the
     * range the record declares and no longer the tree — so the confirmation is about the delivery
     * that was recorded, not about the one the next draft will record. The field report read the
     * green as "the correction worked" and wrote that conclusion down; re-drafting produced the
     * escape again.
     */
    await updateYaml(root, `xforge/changes/${change}/work-packages.yaml`, (plan: any) => {
      plan.packages[0].write_paths.push('src/shared/**');
    });
    await commit(root, 'correct the plan');

    const after = await runCli(root, ['check', '--change', change, '--gate', 'structure']);
    const stale = after.json.diagnostics.find((item: any) => item.code === 'XFORGE_WORK_PACKAGE_DELIVERY_RECORD_STALE');
    expect(stale, JSON.stringify(after.json.diagnostics.map((item: any) => item.code))).toBeDefined();
    expect(stale.severity).toBe('info');
    expect(stale.message).toContain('work-packages.yaml');
    expect(stale.message).toContain('work-package draft');
    /* The verdict itself is unchanged: the recorded delivery is still fine, and this is scope, not
       a failure. */
    expect(after.code, JSON.stringify(after.json.diagnostics.filter((item: any) => item.severity === 'error'))).toBe(0);
  }, 600_000);

  it('shows what a failed verify command printed instead of only its exit code', async () => {
    const built = await project().flow('solid').packages(1).atStage('apply').build();
    /*
     * A suite that fails the way suites do: a line naming the case, printed last. The draft recorded
     * `exit_code: 1` and nothing else, so the only way to learn which case was red was to run the
     * command a second time by hand — which the field report did.
     */
    await updateYaml(built.root, `xforge/changes/${built.change}/work-packages.yaml`, (plan: any) => {
      plan.packages[0].verify = [[process.execPath, '-e', 'console.error("FAIL test/skeleton.test.ts > probe package"); process.exit(1)']];
    });
    expect((await runCli(built.root, ['work-package', 'dispatch', '--change', built.change, '--package', PACKAGE])).code).toBe(0);
    await commit(built.root, 'dispatch');
    await write(built.root, `src/${PACKAGE}/widget.ts`, 'export const widget = true;\n');
    await commit(built.root, 'work');

    const drafted = await runCli(built.root, ['work-package', 'draft', '--change', built.change, '--package', PACKAGE]);
    const failure = drafted.json.diagnostics.find((item: any) => item.code === 'XFORGE_WORK_PACKAGE_VERIFY_NONZERO');
    expect(failure, JSON.stringify(drafted.json.diagnostics.map((item: any) => item.code))).toBeDefined();
    expect(failure.severity).toBe('warning');
    expect(failure.message).toContain('FAIL test/skeleton.test.ts > probe package');
    /* The record still says only what it observed; the output is reported, not written into the
       governed ledger. */
    expect(drafted.json.data.delivery.validation[0].exit_code).toBe(1);
  }, 600_000);

  it('tells a terminal approver to drop --provider rather than calling local unauthorized', async () => {
    const built = await project().flow('solid').atStage('check').build();

    /*
     * `local` is a real entry in the policy's `providers`, and `xforge state` printed it with an
     * `id`, so it read as an argument this command takes. It is not one: `--provider` names an MCP
     * provider declared in the manifest, and terminal approval is what happens without the flag.
     * The old refusal said "Approval provider is not authorized: local" and pointed at `doctor`,
     * sending the reader after a configuration gap that does not exist.
     */
    const refused = await runCli(built.root, [
      'approve', '--provider', 'local', '--for', 'apply', '--change', built.change,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.json.diagnostics[0].code).toBe('XFORGE_APPROVAL_PROVIDER_FORBIDDEN');
    expect(refused.json.diagnostics[0].message).toContain('Terminal approval takes no --provider');
    expect(JSON.stringify(refused.json.nextActions)).not.toContain('doctor');

    /* And `state` stops advertising the id that is not one. The kind is still reported: a reader
       has to be able to tell a policy that permits terminal approval from one that does not. */
    const state = await runCli(built.root, ['state', '--change', built.change]);
    const pending = state.json.data.change.governance.pendingApprovals as any[];
    const local = pending.flatMap((item) => item.providers).filter((item: any) => item.type === 'local');
    expect(local.length).toBeGreaterThan(0);
    for (const entry of local) expect(entry).toEqual({ type: 'local' });
  }, 600_000);
});

/** The draft, completed the way a Worker would — see `acknowledge-supersede` for the full shape. */
async function writeDelivery(root: string, draft: any): Promise<void> {
  const cited = draft.delivery.changed_paths[0];
  expect(cited, 'the package must have changed something for its evidence to cite').toBeTruthy();
  await write(root, draft.target, stringify({
    ...draft.delivery,
    status: 'succeeded',
    issues: [],
    done_when_evidence: (draft.delivery.done_when_evidence ?? []).map((entry: any) => ({
      criterion: entry.criterion,
      evidence: [`${cited} — written by this package`],
    })),
  }));
}

async function commit(root: string, message: string): Promise<void> {
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, 'commit', '-qm', message]);
}
