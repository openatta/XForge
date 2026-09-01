import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fixture, runCli } from '../helpers.js';

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

  it('says nothing when the name is a Git author of the repository', async () => {
    const root = await committed();
    const result = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["npm","test"]', '--by', AUTHOR, '--dry-run']);
    expect((result.json.diagnostics as any[]).map((item) => item.code))
      .not.toContain('XFORGE_VERIFICATION_DECLARER_UNATTESTED');
  });
});
