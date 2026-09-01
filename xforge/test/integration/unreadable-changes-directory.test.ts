import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli } from '../helpers.js';

/**
 * What three commands say when they cannot read the Changes directory at all.
 *
 * Each had its own copy of the same listing and each returned "none" for every error, so a failed
 * read became the fact "this project has no Change in flight" — and all three then acted on it.
 * `upgrade-scaffold` exists to refuse while Changes are open and instead proceeded, without even
 * the warning it emits when a user overrides that deliberately. `contract status` reported nothing
 * competing for a baseline element, which is the sentence an operator reads to conclude the
 * baseline is safe to merge into. `doctor` walks these directories to learn which Flows are in use,
 * so every Flow but the manifest default became dead code.
 *
 * Only `ENOENT` is an answer: a project creates the directory with its first Change. The fixture
 * replaces the directory with a regular file, which is `ENOTDIR` for any user — a permission bit
 * would prove nothing when the suite runs as root.
 */
describe('an unreadable Changes directory', () => {
  async function blocked(): Promise<string> {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await rm(path.join(root, 'xforge', 'changes'), { recursive: true, force: true });
    await writeFile(path.join(root, 'xforge', 'changes'), 'not a directory\n');
    return root;
  }

  it('stops an upgrade instead of reporting that nothing is in flight', async () => {
    const result = await runCli(await blocked(), ['upgrade-scaffold']);
    expect(result.code).not.toBe(0);
    const codes = (result.json.diagnostics as any[]).map((item) => item.code);
    expect(codes).toContain('XFORGE_CHANGES_DIRECTORY_UNREADABLE');
    /* Not the accepted-anyway warning, and not silence: --with-active-changes accepts a named list
       of Changes, and there is no list here for anybody to have accepted. */
    expect(codes).not.toContain('XFORGE_UPGRADE_ACTIVE_CHANGES_ACCEPTED');
  });

  it('refuses to call a baseline unclaimed when it could not read who claims it', async () => {
    const result = await runCli(await blocked(), ['contract', 'status']);
    expect(result.json.ok).toBe(false);
    expect((result.json.diagnostics as any[]).map((item) => item.code)).toContain('XFORGE_CHANGES_DIRECTORY_UNREADABLE');
  });

  it('says so in doctor rather than reporting every Flow as unused', async () => {
    const result = await runCli(await blocked(), ['doctor']);
    expect((result.json.diagnostics as any[]).map((item) => item.code)).toContain('XFORGE_CHANGES_DIRECTORY_UNREADABLE');
  });
});
