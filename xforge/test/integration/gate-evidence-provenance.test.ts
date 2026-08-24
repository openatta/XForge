import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { advanceSolidToApply, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

async function git(root: string, args: string[]): Promise<string> {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

/*
 * Gate Evidence binds to the *content* revision -- Artifacts, Flow, policy snapshot -- and never to
 * the code tree. That is deliberate: folding `gitHead` in was tried and abandoned, because
 * committing the Evidence a Gate had just produced then invalidated every Gate and Approval on the
 * Change. The cost of the exclusion is that Evidence reads as perfectly current while the code it
 * exercised sits several merges behind, and nothing said so.
 *
 * Exactly how a live Major reached archive readiness: verify ran three mandatory Gates, the Change
 * went back to apply to add two more work packages, merged them, and returned. No governed Artifact
 * moved, so the content revision did not either, and all three Gates kept reporting as bound to the
 * current revision while certifying a tree two merges old. A human found it by diffing the
 * Evidence's own `gitHead` field; no CLI reading showed it.
 */
describe('Gate Evidence provenance against the code tree', () => {
  it('reports the commit a Gate ran at, and the source files that moved since', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['init', '-q']);
    await git(root, ['config', 'user.name', 'XForge Test']);
    await git(root, ['config', 'user.email', 'test@example.test']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-qm', 'base']);
    await advanceSolidToApply(root);

    await runCli(root, ['check', '--change', 'add-feature']);
    const ranAt = await git(root, ['rev-parse', 'HEAD']);

    /* Only Gates that have actually run carry provenance; a Gate the Stage has not reached yet
       reports nulls throughout, which is a different fact and asserted separately below. */
    const ran = (result: any): any[] => (result.json.data.change.mandatoryGateEvidence as any[]).filter((entry) => entry.status !== null);
    const pending = (result: any): any[] => (result.json.data.change.mandatoryGateEvidence as any[]).filter((entry) => entry.status === null);

    const before = await runCli(root, ['state', '--change', 'add-feature']);
    const evidenceBefore = ran(before);
    expect(evidenceBefore.length).toBeGreaterThan(0);
    for (const entry of evidenceBefore) {
      expect(entry.currentContentRevision).toBe(true);
      expect(entry.gitHead).toBe(ranAt);
      expect(entry.sourceFilesChangedSince).toBe(0);
    }

    /*
     * Committing XForge's own output must not read as the code having moved -- that is the whole
     * reason the commit is not an input to the content revision.
     */
    await git(root, ['add', '.']);
    await git(root, ['commit', '-qm', 'record the evidence']);
    const afterEvidenceCommit = await runCli(root, ['state', '--change', 'add-feature']);
    for (const entry of ran(afterEvidenceCommit)) {
      expect(entry.currentContentRevision).toBe(true);
      expect(entry.sourceFilesChangedSince).toBe(0);
    }

    /* A source commit is the case that matters, and it moves nothing the content revision watches. */
    await write(root, 'src/order/refund.ts', 'export const refund = false;\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-qm', 'change the implementation']);

    const after = await runCli(root, ['state', '--change', 'add-feature']);
    const evidenceAfter = ran(after);
    expect(evidenceAfter.length).toBeGreaterThan(0);
    for (const entry of evidenceAfter) {
      /* Still current by content -- which is precisely why this was invisible. */
      expect(entry.currentContentRevision).toBe(true);
      expect(entry.gitHead).toBe(ranAt);
      expect(entry.sourceFilesChangedSince).toBe(1);
    }

    /* A Gate this Stage has not run reports nothing rather than a misleading zero. */
    for (const entry of pending(after)) {
      expect(entry).toMatchObject({ currentContentRevision: null, gitHead: null, sourceFilesChangedSince: null });
    }
  });

  /* Unknown must be reported as unknown: a rebase is not "a hundred files changed". */
  it('reports null rather than a count when the Evidence commit is not in the current history', async () => {
    const root = await fixture();
    const { codeMovedSince } = await import('../../src/core/revision.js');
    const { loadProject } = await import('../../src/core/project-loader.js');
    await createCompleteSolidChange(root);
    await git(root, ['init', '-q']);
    await git(root, ['config', 'user.name', 'XForge Test']);
    await git(root, ['config', 'user.email', 'test@example.test']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-qm', 'base']);
    const project = await loadProject(root, { exactRoot: true });

    expect(await codeMovedSince(project, 'add-feature', 'f'.repeat(40))).toBeNull();
    expect(await codeMovedSince(project, 'add-feature', null)).toBeNull();
    expect(await codeMovedSince(project, 'add-feature', 'not-a-commit')).toBeNull();
  });

  /*
   * `git diff --name-only` prints paths relative to the repository root, not to wherever the
   * command was run. A project nested inside a larger repository would therefore have every
   * exclusion prefix silently stop matching, and the count would sweep in the sibling projects.
   * Reporting nothing is right here: the number would be about a tree this Change does not own.
   */
  it('reports null when the project root is not the Git worktree root', async () => {
    const outer = await fixture();
    const { codeMovedSince } = await import('../../src/core/revision.js');
    const { loadProject } = await import('../../src/core/project-loader.js');
    const { mkdir, cp } = await import('node:fs/promises');
    const path = await import('node:path');

    /* A repository whose root sits one level above the XForge project. */
    const repo = path.join(outer, '..', `${path.basename(outer)}-repo`);
    const nested = path.join(repo, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    await cp(outer, nested, { recursive: true });
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.name', 'XForge Test']);
    await git(repo, ['config', 'user.email', 'test@example.test']);
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-qm', 'base']);
    const ranAt = await git(repo, ['rev-parse', 'HEAD']);
    /* A second commit, so the heads differ and the "nothing moved at all" shortcut cannot be what
       makes this pass -- that shortcut is correct in a monorepo and would hide the guard. */
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(repo, 'packages', 'app', 'src-file.ts'), 'export const x = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-qm', 'second']);

    const project = await loadProject(nested, { exactRoot: true });
    expect(await codeMovedSince(project, 'add-feature', ranAt)).toBeNull();
  });
});
