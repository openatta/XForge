import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { advanceSolidToApply, clearVerification, createCompleteSolidChange, fixture, runCli } from '../helpers.js';

/**
 * Who says how this project verifies itself, and whether the repository has ever seen them.
 *
 * `decidedBy`, `resolvedBy` and `approvedBy` are each checked against an approver on a receipt or a
 * Git author, and the Skills spend paragraphs on why. `verification declare --by` was checked
 * against nothing: a live run recorded `--by 'Nobody Who Exists'` and got `ok: true` with an empty
 * diagnostics list, while the ledger written in the same Stage refused an unattestable name. What
 * that field records is who decided the command every later Gate run executes and trusts, and it
 * lands in the governed Manifest.
 *
 * Reported, not refused. A legitimate declaration is routinely attributed to somebody with no
 * commits here — a role a person answered as, an owner a request document names. The defect was the
 * silence, so silence is what this closes.
 */
describe('who declared a verification command', () => {
  const AUTHOR = 'Devi Srinivasan <devi.srinivasan@example.test>';

  /**
   * A repository with history. Without one there is nothing to check a name against, and the check
   * deliberately stays quiet — punishing the first declaration in a new repository for the
   * repository being new is the same mistake `unknownIdentityReason` already refuses to make.
   */
  async function committed(): Promise<string> {
    const root = await fixture();
    const run = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    run(['init', '--quiet']);
    run(['config', 'user.name', 'Devi Srinivasan']);
    run(['config', 'user.email', 'devi.srinivasan@example.test']);
    run(['add', '.']);
    run(['commit', '--quiet', '-m', 'Seed']);
    return root;
  }

  it('says so when the repository cannot attest the name', async () => {
    const root = await committed();
    const result = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["npm","test"]', '--by', 'Nobody Who Exists', '--dry-run']);
    const warned = (result.json.diagnostics as any[]).filter((item) => item.code === 'XFORGE_VERIFICATION_DECLARER_UNATTESTED');
    expect(warned.length, JSON.stringify((result.json.diagnostics as any[]).map((item) => item.code))).toBe(1);
    expect(warned[0].message).toContain('Nobody Who Exists');
    /* Recorded rather than refused: the name is kept and the reader is told it is unchecked. */
    expect(warned[0].severity).toBe('warning');
    expect(result.json.ok).toBe(true);
  });

  /**
   * `draft-receipt` names what a person still owes, and it named one of two.
   *
   * `finalize` refuses without `--status` and `--by`. `supply` listed `status` alone, while
   * `state`'s nextActions and the `xforge-verify` Skill both name `--by`. A live run drafted the
   * receipt, read `supply` as the authoritative list of what it owed — which is what the field name
   * promises — and met XFORGE_VERIFICATION_ARGUMENTS_REQUIRED a command later.
   */
  /**
   * The caveat has to outlive the command that raised it.
   *
   * `declare` warns once, at the moment of declaring, and the Manifest then keeps `declaredBy` with
   * no marker that it was unverified. A live run put it exactly: "it does not persist anywhere —
   * only whoever ran the command ever knows." A record of who chose how this project verifies
   * itself is read long after that person has gone, which is when the caveat matters most.
   *
   * Re-derived rather than stored: a stored flag would go stale the first time somebody commits.
   */
  it('is still reported by doctor long after the declaration', async () => {
    const root = await committed();
    /* The fixture ships declarations of its own; this test is about the one it makes. */
    await clearVerification(root);
    await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["npm","test"]', '--by', 'Nobody Who Exists']);

    const doctored = await runCli(root, ['doctor']);
    const found = (doctored.json.data as any).suggestions
      .filter((item: any) => item.code === 'XFORGE_DOCTOR_VERIFICATION_DECLARER_UNATTESTED');
    expect(found.length, JSON.stringify((doctored.json.data as any).suggestions.map((i: any) => i.code))).toBe(1);
    expect(found[0].message).toContain('Nobody Who Exists');
    /* The command is not in doubt — only the record of who chose it. */
    expect(found[0].message).toContain('The command still runs');
  });

  it('says nothing in doctor when the declarer is a Git author', async () => {
    const root = await committed();
    /* The fixture ships declarations of its own; this test is about the one it makes. */
    await clearVerification(root);
    await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["npm","test"]', '--by', AUTHOR]);
    const doctored = await runCli(root, ['doctor']);
    expect(((doctored.json.data as any).suggestions as any[]).map((item) => item.code))
      .not.toContain('XFORGE_DOCTOR_VERIFICATION_DECLARER_UNATTESTED');
  });

  it('names both fields a person must supply, not just the status', async () => {
    const root = await committed();
    await createCompleteSolidChange(root, 'add-feature');
    /* draft-receipt only answers at the Stage that declares the receipt condition. */
    await advanceSolidToApply(root, 'add-feature');
    await runCli(root, ['transition', '--change', 'add-feature', '--to', 'verify']);
    const result = await runCli(root, ['verification', 'draft-receipt', '--change', 'add-feature']);
    const supply = ((result.json.data as any)?.supply ?? []) as string[];
    expect(supply.length, JSON.stringify(result.json.data ?? result.json.diagnostics)).toBe(2);
    expect(supply.join(' ')).toContain('status:');
    expect(supply.join(' ')).toContain('by:');
  });

  it('says nothing when the name is a Git author of the repository', async () => {
    const root = await committed();
    const result = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["npm","test"]', '--by', AUTHOR, '--dry-run']);
    expect((result.json.diagnostics as any[]).map((item) => item.code))
      .not.toContain('XFORGE_VERIFICATION_DECLARER_UNATTESTED');
  });
});
