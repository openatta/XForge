import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { project } from '../project-builder.js';
import { runCli, write } from '../helpers.js';

/**
 * Verify runs for an execution, or it does not run.
 *
 * A live run reported `xforge check` executing every package's `verify` — ten packages, three
 * commands each, over two minutes — and named the piece of evidence that decides what kind of defect
 * it is: the run produced `evidence/agents/wp-tool-surface/verify-*.json` for a package that had
 * **not been dispatched**. Not a worker exceeding its scope; `check` running the whole plan.
 *
 * The cost was reported as the problem and the cost is the smaller half. A Gate Evidence file is an
 * attestation, filed in the Change's evidence directory and read by the control plane on its own.
 * One naming a package that nobody had started attests the verification of work that did not exist.
 *
 * Both halves come from the same missing key. The synthesized Gate filed its Evidence at
 * `agents/<package>/verify-<n>.json` — a package and a position in a list, with no execution in it —
 * while the dispatch receipt, the delivery record and the acknowledgement receipt are all keyed by
 * `execution_id`. Four artifacts describe one execution and only three could say which one. Keying
 * the fourth the same way answers both: evidence that names its execution, and no execution to name
 * for a package that was never dispatched.
 */
describe('verify evidence is keyed by execution', () => {
  /** Two packages whose verify commands leave a mark, so the tree says which ones ran. */
  async function twoPackagesAtApply(): Promise<{ root: string; change: string }> {
    const built = await project().flow('solid').packages(2).scope(['src/**']).atStage('apply').build();
    const packages = ['wp-001', 'wp-002'].map((id) => ({
      id,
      goal: `Implement ${id}`,
      depends_on: [],
      inputs: [`xforge/changes/${built.change}/design.md`],
      write_paths: [`src/${id}/**`],
      skills: ['xforge-apply'],
      verify: [[process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(`${id}-verify-ran`)}, 'yes')`]],
      done_when: [`${id} is covered by an automated check`],
    }));
    await write(built.root, `xforge/changes/${built.change}/work-packages.yaml`,
      stringify({ apiVersion: 'xforge.dev/v1alpha1', kind: 'WorkPackagePlan', packages }, { lineWidth: 200 }));
    return built;
  }

  /** The execution the dispatch receipt minted — the key every other artifact of this run carries. */
  async function executionOf(root: string, change: string, packageId: string): Promise<string> {
    const directory = path.join(root, 'xforge', 'changes', change, 'evidence', 'agents', packageId, 'dispatch');
    const [name] = await readdir(directory);
    return JSON.parse(await readFile(path.join(directory, name!), 'utf8')).executionId as string;
  }

  it('runs verify only for a package that has been dispatched', async () => {
    const built = await twoPackagesAtApply();
    expect((await runCli(built.root, ['work-package', 'dispatch', '--change', built.change, '--package', 'wp-001'])).code).toBe(0);

    const result = await runCli(built.root, ['check', '--change', built.change]);

    /* The dispatched package is verified exactly as before. */
    expect(existsSync(path.join(built.root, 'wp-001-verify-ran'))).toBe(true);
    expect(result.json.data.workPackages.map((item: any) => item.packageId)).toEqual(['wp-001']);
    /*
     * And the undispatched one is not touched. This is the reported symptom — minutes of external
     * commands for work not yet started — but the assertion below is the one that matters.
     */
    expect(existsSync(path.join(built.root, 'wp-002-verify-ran'))).toBe(false);

    /*
     * And it says so. A check that quietly runs fewer commands than the plan declares reads as a
     * check that found nothing to say, which is how the reported run came to trust a verify that
     * had not happened — in the other direction, but from the same silence.
     */
    const notice = result.json.diagnostics.find((item: any) => item.code === 'XFORGE_WORK_PACKAGE_VERIFY_NOT_DISPATCHED');
    expect(notice.severity).toBe('info');
    expect(notice.message).toContain('wp-002');
    expect(notice.message).not.toContain('wp-001');
  }, 600_000);

  it('files no evidence for a package that has no execution to attest', async () => {
    const built = await twoPackagesAtApply();
    expect((await runCli(built.root, ['work-package', 'dispatch', '--change', built.change, '--package', 'wp-001'])).code).toBe(0);
    await runCli(built.root, ['check', '--change', built.change]);

    /*
     * The whole of it. An Evidence file is read by the control plane on its own — `gateBlockReason`
     * decides from the file, not from who asked for it — so one sitting under `agents/wp-002/`
     * says that package's declared verification passed, on a Change where nobody has started it.
     */
    const undispatched = path.join(built.root, 'xforge', 'changes', built.change, 'evidence', 'agents', 'wp-002');
    expect(existsSync(undispatched)).toBe(false);
  }, 600_000);

  it('names the execution in the path, as the delivery and the receipts already do', async () => {
    const built = await twoPackagesAtApply();
    expect((await runCli(built.root, ['work-package', 'dispatch', '--change', built.change, '--package', 'wp-001'])).code).toBe(0);
    await runCli(built.root, ['check', '--change', built.change]);

    const execution = await executionOf(built.root, built.change, 'wp-001');
    const evidence = path.join(built.root, 'xforge', 'changes', built.change, 'evidence', 'agents', 'wp-001', 'verify', `${execution}-1.json`);
    expect(existsSync(evidence), `expected verify evidence at ${path.relative(built.root, evidence)}`).toBe(true);
    /* Alongside `dispatch/<execution>.json` and `<execution>.yaml`, under the same key. */
    expect(existsSync(path.join(built.root, 'xforge', 'changes', built.change, 'evidence', 'agents', 'wp-001', 'dispatch', `${execution}.json`))).toBe(true);
    /* And nothing at the old unkeyed name, which could only ever hold one execution's result. */
    expect(existsSync(path.join(built.root, 'xforge', 'changes', built.change, 'evidence', 'agents', 'wp-001', 'verify-1.json'))).toBe(false);

    const record = JSON.parse(await readFile(evidence, 'utf8'));
    expect(record).toMatchObject({ status: 'passed', change: built.change });
  }, 600_000);
  /*
   * The other side of the guard, and the reason it is a parameter rather than an assumption.
   *
   * `work-package dispatch` refuses any Flow that is not Protocol 2 governed, while `checker.ts`
   * resolves plans for every Flow. On an older Flow no package can ever hold an execution, so
   * skipping on its absence would stop running that project's verify commands altogether — the same
   * silence this change removes, pointed the other way.
   */
  it('still runs every verify on a Flow that cannot dispatch at all', async () => {
    const { workPackageVerificationGates } = await import('../../src/core/work-packages.js');
    const plan = {
      path: 'xforge/changes/add-feature/work-packages.yaml',
      baseCommit: null, ready: [], waves: [], parallelCandidates: [],
      protectedWritePaths: [], unattributedPaths: [],
      packages: [{
        id: 'wp-001', goal: 'g', depends_on: [], inputs: [], write_paths: ['src/**'], skills: [],
        verify: [[process.execPath, '-e', 'process.exit(0)']], done_when: ['done'],
        status: 'ready' as const, missingDependencies: [], delivery: null,
        acknowledgements: { reviewedBy: null, integratedBy: null }, executionId: null,
      }],
    };

    /* Dispatching Flow: no execution, no Gate — the fix. */
    expect(workPackageVerificationGates(plan, true)).toEqual([]);

    /* Non-dispatching Flow: the command still runs, under the only name available to it. */
    const gates = workPackageVerificationGates(plan, false);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.gate.spec.evidence).toBe('agents/wp-001/verify-1.json');
  });
});
