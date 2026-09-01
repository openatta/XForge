import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { advanceSolidToApply, clearVerification, createCompleteSolidChange, fixture, runCli } from '../helpers.js';

/**
 * Who signed the verification receipt, checked against the repository.
 *
 * `declare` reported an unattestable `--by` and `finalize` took one in silence, which is backwards:
 * `declare` records who chose a command, `finalize` records who asserts the Stage verified the
 * work, and it is the artifact that carries that assertion into the archive. A hand-driven run met
 * exactly that — the prompt said the CLI would flag a role name, the CLI said nothing, and the
 * receipt read `finalizedBy: project owner` with no mark against it.
 *
 * Reported, never refused: a person who has not committed here yet is still a person, and the
 * receipt is written either way.
 *
 * @red-first coverage-only: the fix landed one commit earlier, so this passes against its parent.
 * It exists because a hand-driven run reported the opposite and I answered by reading the source --
 * the check sits after the refusal throw and before the write, so it must fire -- when what the
 * report actually showed was a CLI installed before the fix. Reading told me where the code was;
 * only a run tells me it runs.
 */
describe('the verification receipt names who asserted it', () => {
  const CHANGE = 'add-feature';

  async function readyToFinalize(): Promise<string> {
    const root = await fixture();
    const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Devi Srinivasan']);
    git(['config', 'user.email', 'devi.srinivasan@example.test']);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'Seed']);
    await clearVerification(root);
    await createCompleteSolidChange(root, CHANGE);
    await advanceSolidToApply(root, CHANGE);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']);
    await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["node","-e","process.exit(0)"]', '--by', 'Devi Srinivasan <devi.srinivasan@example.test>']);
    const ran = await runCli(root, ['check', '--change', CHANGE]);
    expect(((ran.json.data as any)?.gates ?? []).map((gate: any) => `${gate.id}:${gate.status}`),
      JSON.stringify(ran.json.diagnostics)).toEqual(['structure:passed', 'unit-tests:passed']);
    return root;
  }

  it('says so when the signer is a name the repository cannot attest', async () => {
    const root = await readyToFinalize();
    const done = await runCli(root, ['verification', 'finalize', '--change', CHANGE,
      '--status', 'passed', '--by', 'project owner']);
    expect(done.json.ok, JSON.stringify(done.json.diagnostics)).toBe(true);
    const warned = (done.json.diagnostics as any[]).filter((item) => item.code === 'XFORGE_VERIFICATION_DECLARER_UNATTESTED');
    expect(warned.length, JSON.stringify((done.json.diagnostics as any[]).map((item) => item.code))).toBe(1);
    expect(warned[0].message).toContain('project owner');
    expect(warned[0].severity).toBe('warning');
    /* Reported, not refused: the receipt is still written. */
    expect((done.json.changes as any[]).some((change) => change.path.endsWith('verification-receipt.yaml'))).toBe(true);
  });

  it('says nothing when the signer is a Git author of the repository', async () => {
    const root = await readyToFinalize();
    const done = await runCli(root, ['verification', 'finalize', '--change', CHANGE,
      '--status', 'passed', '--by', 'Devi Srinivasan <devi.srinivasan@example.test>']);
    expect(done.json.ok).toBe(true);
    expect((done.json.diagnostics as any[]).map((item) => item.code))
      .not.toContain('XFORGE_VERIFICATION_DECLARER_UNATTESTED');
  });
});
