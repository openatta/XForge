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
 *
 * @red-first coverage-only: the git-unavailable case closes XFORGE_STAGE_BUNDLE_GIT_UNAVAILABLE in
 * the untested-code list. The behaviour shipped correct; nobody had ever asserted it, so there is no
 * fix for it to fail without.
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

  it('vouches for nothing when git cannot answer at all', async () => {
    /*
     * A project that is not a repository. Every voucher rests on `git diff` between two commits, so
     * a tree git will not speak about is a tree this cannot speak about either — and saying that is
     * the whole difference between "nothing changed" and "nothing is known".
     */
    const root = await fixture();
    await createCompleteSolidChange(root);

    const result = await runCli(root, ['stage-bundle', '--change', CHANGE]);
    expect(result.code).toBe(0);
    const notice = (result.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_STAGE_BUNDLE_GIT_UNAVAILABLE');
    expect(notice, JSON.stringify((result.json.diagnostics as any[]).map((item) => item.code))).toBeDefined();
    expect(notice.severity).toBe('warning');
    expect(result.json.data.vouched).toEqual([]);
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

  /*
   * Git names files from the repository root. This command compares them with paths relative to the
   * project root, and until `--show-prefix` was subtracted those were the same string only when the
   * project was the repository — so in a monorepo every diffed path arrived as `app/xforge/...`,
   * matched nothing, and a document that had changed was handed back with a digest offered as the
   * text the previous Stage read. The failure the module's own header calls worse than re-reading.
   */
  it('sees what changed when the project is not the repository root', async () => {
    const repository = await fixture('xforge-monorepo-');
    /* The fixture is the project; the repository is its parent, so the project sits at `app/`. */
    const { mkdir, cp, rm } = await import('node:fs/promises');
    const project = `${repository}/app`;
    await mkdir(project, { recursive: true });
    for (const entry of ['xforge', 'src']) {
      await cp(`${repository}/${entry}`, `${project}/${entry}`, { recursive: true, force: true }).catch(() => {});
      await rm(`${repository}/${entry}`, { recursive: true, force: true });
    }
    await createCompleteSolidChange(project);
    for (const args of [['init', '-q'], ['config', 'user.name', 'XForge Test'], ['config', 'user.email', 'test@example.test']]) {
      await run('git', ['-C', repository, ...args]);
    }
    await commit(repository, 'the Change as the Stage received it');
    await advanceSolidToApply(project);
    await commit(repository, 'the transition receipts');
    await write(project, `xforge/changes/${CHANGE}/proposal.md`, '# Proposal\n\n## Problem\n\nRewritten inside this Stage.\n');
    await commit(repository, 'an edit made during apply');

    const result = await runCli(project, ['stage-bundle', '--change', CHANGE]);
    expect(result.code, JSON.stringify(result.json?.diagnostics)).toBe(0);
    const read = result.json.data.read as Array<{ path: string; reason: string }>;
    const vouched = result.json.data.vouched as Array<{ path: string }>;
    expect(read.find((entry) => entry.path.endsWith('proposal.md'))?.reason).toBe('changed-since-stage-entered');
    expect(vouched.map((entry) => entry.path)).not.toContain(`xforge/changes/${CHANGE}/proposal.md`);
  });

  /*
   * A baseline commit git cannot reach — a shallow clone, a rebased or pruned history — used to end
   * with an empty changed-set that read exactly like "nothing moved", so the command warned that
   * nothing could be vouched for and then vouched for everything. Not knowing is not the same as
   * knowing there was no change.
   */
  it('vouches for nothing when it cannot make the comparison', async () => {
    const root = await committedChange();
    await advanceSolidToApply(root);
    await commit(root, 'the transition receipts');
    await write(root, `xforge/changes/${CHANGE}/proposal.md`, '# Proposal\n\n## Problem\n\nRewritten inside this Stage.\n');
    await commit(root, 'an edit made during apply');

    /* A shallow clone: the tree is clean and the receipt is intact, but the commit it names as the
       Stage's baseline is not in this repository's object store, so `git diff` cannot answer. */
    const shallow = `${root}-shallow`;
    await run('git', ['clone', '--quiet', '--depth', '1', `file://${root}`, shallow]);

    const result = await runCli(shallow, ['stage-bundle', '--change', CHANGE]);
    expect(result.json.data.worktreeClean).toBe(true);
    expect(result.json.data.since).not.toBeNull();
    /* Not one document is taken on a digest, and each says why. */
    expect(result.json.data.vouched).toEqual([]);
    const read = result.json.data.read as Array<{ path: string; reason: string }>;
    expect(read.some((entry) => entry.reason === 'comparison-unavailable')).toBe(true);
    expect(JSON.stringify(result.json.diagnostics)).toContain('XFORGE_STAGE_BUNDLE_GIT_UNAVAILABLE');
  });
});
