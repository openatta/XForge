import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, runCli, updateYaml, write } from '../helpers.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

describe('install lifecycle', () => {
  it('is dry-run safe, installs all five targets, and is idempotent', async () => {
    const root = await fixture();
    const dry = await runCli(root, ['install', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stderr).toBe('');
    expect(dry.json.ok).toBe(true);
    expect(await exists(path.join(root, '.agents'))).toBe(false);
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(false);

    const first = await runCli(root, ['install']);
    expect(first.code).toBe(0);
    expect(await exists(path.join(root, '.agents', 'skills', 'xforge-explore', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(root, '.claude', 'commands', 'xforge', 'explore.md'))).toBe(true);
    expect(await exists(path.join(root, '.cursor', 'commands', 'xforge-explore.md'))).toBe(true);
    expect(await exists(path.join(root, '.opencode', 'commands', 'xforge-explore.md'))).toBe(true);
    expect(await exists(path.join(root, '.github', 'prompts', 'xforge-explore.prompt.md'))).toBe(true);
    expect(await exists(path.join(root, '.claude', 'agents', 'worker.md'))).toBe(true);
    expect(await exists(path.join(root, '.claude', 'agents', 'integrator.md'))).toBe(true);
    expect(await exists(path.join(root, '.claude', 'agents', 'reviewer.md'))).toBe(true);
    expect(await exists(path.join(root, '.agents', 'agents', 'worker.md'))).toBe(false);
    const stateBefore = await readFile(path.join(root, 'xforge', '.state.json'), 'utf8');
    const lockBefore = await readFile(path.join(root, 'xforge', 'lock.yaml'), 'utf8');

    const second = await runCli(root, ['install']);
    expect(second.code).toBe(0);
    expect(second.json.changes.every((item: any) => item.action === 'skip')).toBe(true);
    expect(await readFile(path.join(root, 'xforge', '.state.json'), 'utf8')).toBe(stateBefore);
    expect(await readFile(path.join(root, 'xforge', 'lock.yaml'), 'utf8')).toBe(lockBefore);
  });

  it('does not overwrite an unknown destination', async () => {
    const root = await fixture();
    const destination = '.agents/skills/xforge-explore/SKILL.md';
    await write(root, destination, 'human-owned\n');
    const result = await runCli(root, ['install', '--target', 'codex']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INSTALL_CONFLICT');
    expect(await readFile(path.join(root, ...destination.split('/')), 'utf8')).toBe('human-owned\n');
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(false);
  });

  it('protects human modifications and only prunes digest-matching managed files', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    const modified = '.agents/skills/xforge-explore/SKILL.md';
    await write(root, modified, 'human-modified\n');
    const conflict = await runCli(root, ['install', '--target', 'codex']);
    expect(conflict.code).toBe(1);
    expect(conflict.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_MANAGED_FILE_MODIFIED');
    expect(await readFile(path.join(root, ...modified.split('/')), 'utf8')).toBe('human-modified\n');

    const cleanRoot = await fixture();
    expect((await runCli(cleanRoot, ['install', '--target', 'codex'])).code).toBe(0);
    await updateYaml(cleanRoot, 'xforge/manifest.yaml', (manifest) => {
      manifest.scaffold.skills = manifest.scaffold.skills.filter((id: string) => id !== 'xforge-explore');
      manifest.scaffold.agents = [];
    });
    const prune = await runCli(cleanRoot, ['install', '--target', 'codex']);
    expect(prune.code).toBe(0);
    expect(prune.json.changes).toContainEqual(expect.objectContaining({ action: 'delete', path: '.agents/skills/xforge-explore/SKILL.md' }));
    expect(await exists(path.join(cleanRoot, '.agents', 'skills', 'xforge-explore', 'SKILL.md'))).toBe(false);
  });
});
