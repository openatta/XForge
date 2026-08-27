import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { advanceSolidToApply, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

const run = promisify(execFile);
const CHANGE = 'add-feature';

/**
 * What a Stage has to re-read, and what it can take on a digest.
 *
 * Every Stage's Skill says to read the Change's Artifacts from disk, because chat memory is not a
 * source of truth. It is the right instruction and it is expensive: a field report measured sixty
 * kilobytes of governance text re-read at each of six Stages, for a Change whose product code was
 * 4,684 lines — and most of those bytes had not moved since the Stage before read them.
 *
 * The receipt that entered the Stage records the commit it began at, so the set that moved is
 * computable. These tests are about the three rules that keep that from becoming a way to skip
 * evidence, and the third one is the reason this is a test file and not a one-line feature.
 */
describe('xforge stage-bundle', () => {
  async function commit(root: string, message: string): Promise<void> {
    await run('git', ['-C', root, 'add', '.']);
    await run('git', ['-C', root, 'commit', '-qm', message]);
  }

  async function committedChange(): Promise<string> {
    const root = await fixture();
    await createCompleteSolidChange(root);
    for (const args of [['init', '-q'], ['config', 'user.name', 'XForge Test'], ['config', 'user.email', 'test@example.test']]) {
      await run('git', ['-C', root, ...args]);
    }
    await commit(root, 'the Change as the Stage received it');
    return root;
  }

  it('vouches for what has not moved since the Stage was entered', async () => {
    const root = await committedChange();
    await advanceSolidToApply(root);
    await commit(root, 'the transition receipts');

    /* One Artifact edited after the Stage began, and committed so git can see it. */
    await write(root, `xforge/changes/${CHANGE}/proposal.md`, '# Proposal\n\n## Problem\n\nRewritten inside this Stage.\n');
    await commit(root, 'an edit made during apply');

    const result = await runCli(root, ['stage-bundle', '--change', CHANGE]);
    expect(result.code, JSON.stringify(result.json?.diagnostics)).toBe(0);
    expect(result.json.data.worktreeClean).toBe(true);
    expect(result.json.data.since).not.toBeNull();

    const read = (result.json.data.read as Array<{ path: string; reason: string }>);
    const vouched = (result.json.data.vouched as Array<{ path: string; digest: string; sections: string[] }>);

    /* The one that moved is listed to be read, and named as such. */
    const proposal = read.find((entry) => entry.path.endsWith('proposal.md'));
    expect(proposal, JSON.stringify(read)).toBeDefined();
    expect(proposal!.reason).toBe('changed-since-stage-entered');

    /* Something did not move, and carries a digest and the sections it covers rather than its text. */
    expect(vouched.length, JSON.stringify(vouched)).toBeGreaterThan(0);
    expect(vouched.every((entry) => entry.digest.length === 64)).toBe(true);

    /* And the saving is real rather than nominal. */
    expect(result.json.data.bytes.vouched).toBeGreaterThan(0);
  }, 600_000);

  it('always reads the Constitution and the Stage\'s own outputs', async () => {
    const root = await committedChange();
    await advanceSolidToApply(root);
    await commit(root, 'the transition receipts');

    const result = await runCli(root, ['stage-bundle', '--change', CHANGE]);
    const read = (result.json.data.read as Array<{ path: string; reason: string }>);

    /*
     * The Constitution is the one document whose whole point is that nobody skips it, and a Stage's
     * own outputs are work in progress — a digest of either proves nothing worth having.
     */
    const constitution = read.find((entry) => entry.path.endsWith('constitution.md'));
    expect(constitution, JSON.stringify(read)).toBeDefined();
    expect(constitution!.reason).toBe('always');

    const vouched = (result.json.data.vouched as Array<{ path: string }>);
    expect(vouched.some((entry) => entry.path.endsWith('constitution.md'))).toBe(false);
  }, 600_000);

  it('vouches for nothing while the Change has uncommitted edits', async () => {
    const root = await committedChange();
    await advanceSolidToApply(root);
    await commit(root, 'the transition receipts');

    /*
     * The failure this rule exists to prevent, and the reason the whole command is safe to follow.
     *
     * `git diff` answers about commits. An uncommitted edit is invisible to it, so a digest voucher
     * issued over a dirty tree would report "unchanged" about a file that changed — turning a slow
     * instruction into a wrong one, which is worse than the re-reading this command exists to avoid.
     */
    await write(root, `xforge/changes/${CHANGE}/proposal.md`, '# Proposal\n\n## Problem\n\nEdited and not committed.\n');

    const result = await runCli(root, ['stage-bundle', '--change', CHANGE]);
    expect(result.code).toBe(0);
    expect(result.json.data.worktreeClean).toBe(false);
    expect(result.json.data.vouched).toEqual([]);
    expect(result.json.data.bytes.vouched).toBe(0);
    for (const entry of result.json.data.read as Array<{ reason: string }>) {
      expect(['worktree-dirty', 'written-by-this-stage', 'always']).toContain(entry.reason);
    }

    const notice = (result.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_STAGE_BUNDLE_TREE_DIRTY');
    expect(notice, JSON.stringify(result.json.diagnostics)).toBeDefined();
    expect(notice.message).toContain('compares commits');
  }, 600_000);

  it('says so rather than guessing when the Change has no earlier Stage', async () => {
    const root = await committedChange();

    const result = await runCli(root, ['stage-bundle', '--change', CHANGE]);
    expect(result.code).toBe(0);
    expect(result.json.data.since).toBeNull();
    expect(result.json.data.vouched).toEqual([]);
    const notice = (result.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_STAGE_BUNDLE_NO_BASELINE');
    expect(notice, JSON.stringify(result.json.diagnostics)).toBeDefined();
    expect(notice.severity).toBe('info');
  }, 600_000);

  it('prints a reading plan, which is the whole point of the text form', async () => {
    const root = await committedChange();
    await advanceSolidToApply(root);
    await commit(root, 'the transition receipts');

    const text = await runCli(root, ['stage-bundle', '--change', CHANGE, '--text']);
    expect(text.stdout).toContain('READ IN FULL');
    expect(text.stdout).toContain('UNCHANGED — digest stands in for re-reading');
    /* A digest is permission to skip, never a prohibition on looking. */
    expect(text.stdout).toContain('not that reading it is forbidden');
  }, 600_000);
});
