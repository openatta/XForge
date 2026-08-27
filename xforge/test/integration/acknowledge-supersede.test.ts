import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { project } from '../project-builder.js';
import { runCli, write } from '../helpers.js';

/**
 * Correcting a delivery record after the review that asked for the correction.
 *
 * A live governance Change delivered, took an integrator acknowledgement, took a reviewer
 * acknowledgement, and then had an independent review open a finding against the delivery record
 * itself. Correcting it moved the delivery's digest, `loadAckReceipts` dropped both receipts as no
 * longer matching, and every subsequent run reported two permanent
 * `XFORGE_WORK_PACKAGE_ACK_RECEIPT_DELIVERY_MISMATCH` warnings.
 *
 * Re-acknowledging did nothing and returned `ok: true`. Deleting the receipts did not help either:
 * the lifecycle is driven by the audit chain, which is append-only, so `work-package.reviewed` kept
 * the package at `reviewed` with `reviewedBy: null` and no route back. The two ways out were "keep
 * the mismatch warnings forever" or "lose the record that the acknowledgement happened", and the
 * run had to pick one and write the choice into a governed ledger.
 *
 * The state that distinguishes the cases was already computed and unused: `acknowledgements` is
 * populated only from receipts matching the *current* delivery, so `reviewed` with `reviewedBy:
 * null` says exactly "the lifecycle reached it and no surviving receipt covers what is there now".
 */
describe('acknowledge supersede', () => {
  const PACKAGE = 'wp-001';

  it('records a new receipt when the delivery moved under an existing acknowledgement', async () => {
    const built = await project().flow('solid').packages(1).atStage('apply').build();
    await seedAcknowledged(built.root, built.change);

    /* The correction an independent review asks for: the delivery record changes, its digest moves,
       and the receipts that cited the old one stop counting. */
    await amendDelivery(built.root, built.change);
    const stale = await runCli(built.root, ['state', '--change', built.change]);
    const before = stale.json.data.change.workPackages.packages.find((item: any) => item.id === PACKAGE);
    expect(before.status).toBe('reviewed');
    expect(before.acknowledgements.reviewedBy).toBeNull();

    const evidence = `xforge/changes/${built.change}/evidence/agents/${PACKAGE}/review/second.md`;
    await write(built.root, evidence, '# Review\n\nRe-read after the correction.\n');
    const again = await runCli(built.root, [
      'work-package', 'acknowledge', '--change', built.change, '--package', PACKAGE,
      '--as', 'reviewer', '--evidence', evidence,
    ]);

    expect(again.code, JSON.stringify(again.json?.diagnostics)).toBe(0);
    expect(again.json.data.recorded).toBe(true);
    expect(again.json.data.superseded).toBe(true);
    const notice = again.json.diagnostics.find((item: any) => item.code === 'XFORGE_WORK_PACKAGE_ACK_SUPERSEDED');
    expect(notice.severity).toBe('info');
    expect(notice.message).toContain('audit chain');

    /*
     * The reviewer's mismatch is gone and the integrator's is not, because only one was re-signed.
     * That is the honest state: both acknowledgements went stale when the delivery moved, and
     * re-signing one says nothing about the other. Asserting both clear here would have been a test
     * that agreed with itself rather than with the product.
     */
    const after = await runCli(built.root, ['state', '--change', built.change]);
    const stillStale = after.json.diagnostics.filter((item: any) => item.code === 'XFORGE_WORK_PACKAGE_ACK_RECEIPT_DELIVERY_MISMATCH');
    expect(stillStale).toHaveLength(1);
    expect(stillStale[0].path).toContain('integrator');
    const afterReview = after.json.data.change.workPackages.packages.find((item: any) => item.id === PACKAGE);
    expect(afterReview.acknowledgements.reviewedBy).not.toBeNull();
    expect(afterReview.acknowledgements.integratedBy).toBeNull();

    /* Re-signing the other one clears it too, which is the route out that did not exist before. */
    const integration = `xforge/changes/${built.change}/evidence/agents/${PACKAGE}/review/second-integration.md`;
    await write(built.root, integration, '# Integration\n\nRe-checked after the correction.\n');
    const reintegrated = await runCli(built.root, [
      'work-package', 'acknowledge', '--change', built.change, '--package', PACKAGE,
      '--as', 'integrator', '--evidence', integration,
    ]);
    expect(reintegrated.code, JSON.stringify(reintegrated.json?.diagnostics)).toBe(0);
    expect(reintegrated.json.data.superseded).toBe(true);

    const settled = await runCli(built.root, ['state', '--change', built.change]);
    expect(settled.json.diagnostics.filter((item: any) => item.code === 'XFORGE_WORK_PACKAGE_ACK_RECEIPT_DELIVERY_MISMATCH')).toEqual([]);
    const both = settled.json.data.change.workPackages.packages.find((item: any) => item.id === PACKAGE);
    expect(both.acknowledgements.reviewedBy).not.toBeNull();
    expect(both.acknowledgements.integratedBy).not.toBeNull();
  }, 600_000);

  it('says it recorded nothing when the acknowledgement already covers the delivery', async () => {
    const built = await project().flow('solid').packages(1).atStage('apply').build();
    await seedAcknowledged(built.root, built.change);

    const evidence = `xforge/changes/${built.change}/evidence/agents/${PACKAGE}/review/again.md`;
    await write(built.root, evidence, '# Review\n\nSame delivery.\n');
    const redundant = await runCli(built.root, [
      'work-package', 'acknowledge', '--change', built.change, '--package', PACKAGE,
      '--as', 'reviewer', '--evidence', evidence,
    ]);

    expect(redundant.code).toBe(0);
    /*
     * Still a no-op — a redundant call must not accumulate receipts — but no longer a silent one.
     * `ok: true` with nothing written and nothing said is what sent a live run looking for the
     * record in `xforge state` instead of in the command that was supposed to have made it.
     */
    expect(redundant.json.data.recorded).toBe(false);
    const notice = redundant.json.diagnostics.find((item: any) => item.code === 'XFORGE_WORK_PACKAGE_ACK_UNCHANGED');
    expect(notice.severity).toBe('info');
    expect(notice.message).toContain('nothing was recorded');
    expect(redundant.json.changes).toEqual([]);
  }, 600_000);
});

/** Dispatch, deliver, integrate and review one package — the state the trap opens from. */
async function seedAcknowledged(root: string, change: string): Promise<void> {
  expect((await runCli(root, ['work-package', 'dispatch', '--change', change, '--package', 'wp-001'])).code).toBe(0);
  /* The dispatch receipt has to be in a commit: a delivery is measured from the commit that
     dispatched it, which is the model `XFORGE_WORK_PACKAGE_DISPATCH_UNCOMMITTED` states. */
  await commit(root);
  /* Then the package does its work, inside its own declared write path. A delivery that changed
     nothing is refused, correctly, as having delivered nothing. */
  await write(root, 'src/wp-001/widget.ts', 'export const widget = true;\n');
  await commit(root);

  const drafted = await runCli(root, ['work-package', 'draft', '--change', change, '--package', 'wp-001']);
  expect(drafted.code, JSON.stringify(drafted.json?.diagnostics)).toBe(0);
  await writeDelivery(root, change, drafted.json.data);
  for (const [role, name] of [['integrator', 'integration'], ['reviewer', 'review']] as Array<[string, string]>) {
    const evidence = `xforge/changes/${change}/evidence/agents/wp-001/review/${name}.md`;
    await write(root, evidence, `# ${name}\n\nRecorded for the fixture.\n`);
    const result = await runCli(root, ['work-package', 'acknowledge', '--change', change, '--package', 'wp-001', '--as', role, '--evidence', evidence]);
    expect(result.code, `${role}: ${JSON.stringify(result.json?.diagnostics)}`).toBe(0);
  }
}

/**
 * The draft, completed the way a Worker would.
 *
 * The draft deliberately omits what only the Worker can assert -- `status`, the `issues` list, and
 * an evidence entry per `done_when` criterion -- and names them in `supply`. Each evidence entry has
 * to begin with an exact `changed_paths` entry or an exact verify command, which is what keeps a
 * citation pointed at something that happened rather than at a claim.
 */
async function writeDelivery(root: string, change: string, draft: any): Promise<void> {
  const cited = draft.delivery.changed_paths[0];
  expect(cited, 'the package must have changed something for its evidence to cite').toBeTruthy();
  const delivery = {
    ...draft.delivery,
    status: 'succeeded',
    issues: [],
    done_when_evidence: (draft.delivery.done_when_evidence ?? []).map((entry: any) => ({
      criterion: entry.criterion,
      evidence: [`${cited} — written by this package`],
    })),
  };
  await write(root, draft.target, stringify(delivery));
}

/** What a review that finds a fault in the record itself asks for: the record changes. */
async function amendDelivery(root: string, change: string): Promise<void> {
  const relative = path.join(root, 'xforge', 'changes', change, 'evidence', 'agents', 'wp-001');
  const { readdir } = await import('node:fs/promises');
  const name = (await readdir(relative)).find((entry) => entry.endsWith('.yaml'))!;
  const file = path.join(relative, name);
  const delivery = parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  /* A correction the schema accepts, and the one a review most often asks for: the record now says
     what the review found. The delivery stays valid and its digest moves, which is the whole
     situation — an invalid amendment would drop the delivery entirely and prove nothing. */
  delivery.issues = ['Corrected in response to the independent review.'];
  await writeFile(file, stringify(delivery));
}

async function commit(root: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, 'commit', '-qm', 'dispatch']);
}
