import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, runCli, updateYaml, write, yamlFile } from '../helpers.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function ownership(root: string): Promise<any> {
  return JSON.parse(await readFile(path.join(root, 'xforge', '.state.json'), 'utf8'));
}

describe('projection lifecycle v2', () => {
  it('records Adapter source-to-output trace metadata at install time', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    const state = await ownership(root);
    expect(state.version).toBe(2);
    expect(state.protocolVersion).toBe('2');
    expect(state.targets.codex.adapterVersion).toBe('3');
    const record = state.targets.codex.files['.agents/skills/xforge-explore/SKILL.md'];
    expect(record).toMatchObject({
      target: 'codex',
      resource: { kind: 'skill', id: 'xforge-explore' },
      renderVersion: 'codex:skill:3',
      cliVersion: '0.7.1',
    });
    expect(record.sources[0]).toMatchObject({ path: 'xforge/scaffold/skills/xforge-explore/SKILL.md' });
    expect(record.sources[0].mtimeMs).toEqual(expect.any(Number));
    expect(record.sources[0].digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('dry-runs and incrementally syncs a customized Skill with Lock and record updates', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    const sourcePath = 'xforge/scaffold/skills/xforge-explore/SKILL.md';
    const targetPath = '.agents/skills/xforge-explore/SKILL.md';
    const source = await readFile(path.join(root, ...sourcePath.split('/')), 'utf8');
    const stateBefore = await readFile(path.join(root, 'xforge', '.state.json'), 'utf8');
    const lockBefore = await readFile(path.join(root, 'xforge', 'lock.yaml'), 'utf8');
    await write(root, sourcePath, `${source}\n<!-- project customization -->\n`);

    const dry = await runCli(root, ['sync', '--target', 'codex', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.json.data.changedSources).toBeGreaterThan(0);
    expect(dry.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: targetPath }));
    expect(await readFile(path.join(root, ...targetPath.split('/')), 'utf8')).toBe(source);
    expect(await readFile(path.join(root, 'xforge', '.state.json'), 'utf8')).toBe(stateBefore);
    expect(await readFile(path.join(root, 'xforge', 'lock.yaml'), 'utf8')).toBe(lockBefore);

    const synced = await runCli(root, ['sync', '--target', 'codex']);
    expect(synced.code).toBe(0);
    expect(await readFile(path.join(root, ...targetPath.split('/')), 'utf8')).toContain('project customization');
    expect((await ownership(root)).targets.codex.lastSyncedAt).not.toBeNull();
    expect(await readFile(path.join(root, 'xforge', 'lock.yaml'), 'utf8')).not.toBe(lockBefore);

    const again = await runCli(root, ['sync', '--target', 'codex', '--verify-digests']);
    expect(again.code).toBe(0);
    expect(again.json.changes.filter((item: any) => item.path === targetPath)).toEqual([
      expect.objectContaining({ action: 'skip' }),
    ]);
  });

  it('syncs Manifest resource enablement and managed-only pruning within installed targets', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    const targetPath = path.join(root, '.agents', 'skills', 'xforge-status', 'SKILL.md');
    expect(await exists(targetPath)).toBe(true);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.scaffold.skills = manifest.scaffold.skills.filter((id: string) => id !== 'xforge-status');
    });
    const result = await runCli(root, ['sync', '--target', 'codex']);
    expect(result.code).toBe(0);
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'delete', path: '.agents/skills/xforge-status/SKILL.md' }));
    expect(await exists(targetPath)).toBe(false);
  });

  it('refuses to sync or uninstall a generated file modified by a user', async () => {
    const syncRoot = await fixture();
    expect((await runCli(syncRoot, ['install', '--target', 'codex'])).code).toBe(0);
    await write(syncRoot, 'xforge/scaffold/skills/xforge-explore/SKILL.md', 'canonical changed\n');
    await write(syncRoot, '.agents/skills/xforge-explore/SKILL.md', 'human target change\n');
    const sync = await runCli(syncRoot, ['sync', '--target', 'codex']);
    expect(sync.code).toBe(1);
    expect(sync.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_MANAGED_FILE_MODIFIED');
    expect(await readFile(path.join(syncRoot, '.agents', 'skills', 'xforge-explore', 'SKILL.md'), 'utf8')).toBe('human target change\n');

    const uninstall = await runCli(syncRoot, ['uninstall', '--target', 'codex']);
    expect(uninstall.code).toBe(1);
    expect(uninstall.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_UNINSTALL_CONFLICT');
    expect(await exists(path.join(syncRoot, 'xforge', '.state.json'))).toBe(true);
  });

  it('requires full update for Target identity changes and installs newly enabled targets', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.targets = ['codex']; });
    expect((await runCli(root, ['install'])).code).toBe(0);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.targets = ['codex', 'claude']; });

    const sync = await runCli(root, ['sync']);
    expect(sync.code).toBe(1);
    expect(sync.json.diagnostics[0].code).toBe('XFORGE_FULL_UPDATE_REQUIRED');

    const dry = await runCli(root, ['update', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.json.changes).toContainEqual(expect.objectContaining({ action: 'create', path: '.claude/skills/xforge-explore/SKILL.md' }));
    expect(await exists(path.join(root, '.claude', 'skills', 'xforge-explore', 'SKILL.md'))).toBe(false);

    expect((await runCli(root, ['update'])).code).toBe(0);
    expect(await exists(path.join(root, '.claude', 'skills', 'xforge-explore', 'SKILL.md'))).toBe(true);
    expect(Object.keys((await ownership(root)).targets).sort()).toEqual(['claude', 'codex']);
  });

  it('migrates a v1 ownership record through update and refreshes a stale Lock CLI identity', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    const current = await ownership(root);
    const files = Object.fromEntries(Object.entries(current.targets.codex.files).map(([relative, value]: [string, any]) => [relative, {
      source: value.source,
      target: value.target,
      cliVersion: value.cliVersion,
      protocolVersion: value.protocolVersion,
      digest: value.desiredDigest,
      lastInstalledDigest: value.lastInstalledDigest,
    }]));
    await write(root, 'xforge/.state.json', `${JSON.stringify({ version: 1, generatedAt: current.generatedAt, files }, null, 2)}\n`);
    await updateYaml(root, 'xforge/lock.yaml', (lock) => {
      lock.xforge.version = '0.2.0';
      lock.xforge.integrity = `sha256:${'0'.repeat(64)}`;
    });

    const result = await runCli(root, ['update', '--target', 'codex']);
    expect(result.code).toBe(0);
    expect((await ownership(root)).version).toBe(2);
    expect((await yamlFile<any>(root, 'xforge/lock.yaml')).xforge.version).toBe('0.7.1');
  });

  it('uses update to prune a Target removed from the Manifest', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.targets = ['codex', 'claude']; });
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect(await exists(path.join(root, '.claude', 'skills', 'xforge-explore', 'SKILL.md'))).toBe(true);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.targets = ['codex']; });

    const result = await runCli(root, ['update']);
    expect(result.code).toBe(0);
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'delete', path: '.claude/skills/xforge-explore/SKILL.md' }));
    expect(await exists(path.join(root, '.claude', 'skills', 'xforge-explore', 'SKILL.md'))).toBe(false);
    expect(Object.keys((await ownership(root)).targets)).toEqual(['codex']);
  });

  it('dry-runs, uninstalls one target, then removes the final installation record', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    expect((await runCli(root, ['install', '--target', 'claude'])).code).toBe(0);
    const codexPath = path.join(root, '.agents', 'skills', 'xforge-explore', 'SKILL.md');
    const claudePath = path.join(root, '.claude', 'skills', 'xforge-explore', 'SKILL.md');

    const dry = await runCli(root, ['uninstall', '--target', 'codex', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(await exists(codexPath)).toBe(true);

    expect((await runCli(root, ['uninstall', '--target', 'codex'])).code).toBe(0);
    expect(await exists(codexPath)).toBe(false);
    expect(await exists(claudePath)).toBe(true);
    expect(Object.keys((await ownership(root)).targets)).toEqual(['claude']);

    expect((await runCli(root, ['uninstall'])).code).toBe(0);
    expect(await exists(claudePath)).toBe(false);
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(false);
    expect(await exists(path.join(root, 'xforge', 'manifest.yaml'))).toBe(true);
    expect(await exists(path.join(root, 'xforge', 'lock.yaml'))).toBe(true);
  });

  it('allows digest-verified cleanup when the declared CLI identity no longer matches', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.xforge.version = '9.9.9'; });
    const result = await runCli(root, ['uninstall', '--target', 'codex']);
    expect(result.code).toBe(0);
    expect(await exists(path.join(root, '.agents'))).toBe(false);
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(false);
  });

  it('uses an explicit exact project root and never falls back to its parent', async () => {
    const invocationRoot = await fixture('xforge-invocation-');
    const projectRoot = await fixture('xforge-explicit-root-');
    const result = await runCli(invocationRoot, ['--root', projectRoot, 'state']);
    expect(result.code).toBe(0);
    expect(result.json.root).toBe(projectRoot);

    const nested = path.join(projectRoot, 'nested');
    await mkdir(nested);
    const failed = await runCli(invocationRoot, ['--root', nested, 'state']);
    expect(failed.code).toBe(1);
    expect(failed.json.diagnostics[0].code).toBe('XFORGE_ROOT_NOT_FOUND');
  });

  it('requires install before update, sync, or uninstall', async () => {
    const root = await fixture();
    for (const command of ['update', 'sync', 'uninstall']) {
      const result = await runCli(root, [command]);
      expect(result.code).toBe(1);
      expect(result.json.diagnostics[0].code).toBe('XFORGE_NOT_INSTALLED');
    }
  });
});
