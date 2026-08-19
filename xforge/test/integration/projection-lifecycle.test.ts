import { access, mkdir, readFile, rm } from 'node:fs/promises';
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
    const record = state.targets.codex.files['.agents/skills/xforge-kanban/SKILL.md'];
    expect(record).toMatchObject({
      target: 'codex',
      resource: { kind: 'skill', id: 'xforge-kanban' },
      renderVersion: 'codex:skill:3',
      cliVersion: '0.7.16',
    });
    expect(record.sources[0]).toMatchObject({ path: 'xforge/scaffold/skills/xforge-kanban/SKILL.md' });
    expect(record.sources[0].mtimeMs).toEqual(expect.any(Number));
    expect(record.sources[0].digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('dry-runs and incrementally syncs a customized Skill with Lock and record updates', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    const sourcePath = 'xforge/scaffold/skills/xforge-kanban/SKILL.md';
    const targetPath = '.agents/skills/xforge-kanban/SKILL.md';
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
    await write(syncRoot, 'xforge/scaffold/skills/xforge-kanban/SKILL.md', 'canonical changed\n');
    await write(syncRoot, '.agents/skills/xforge-kanban/SKILL.md', 'human target change\n');
    const sync = await runCli(syncRoot, ['sync', '--target', 'codex']);
    expect(sync.code).toBe(1);
    expect(sync.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_MANAGED_FILE_MODIFIED');
    expect(await readFile(path.join(syncRoot, '.agents', 'skills', 'xforge-kanban', 'SKILL.md'), 'utf8')).toBe('human target change\n');

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
    expect(dry.json.changes).toContainEqual(expect.objectContaining({ action: 'create', path: '.claude/skills/xforge-kanban/SKILL.md' }));
    expect(await exists(path.join(root, '.claude', 'skills', 'xforge-kanban', 'SKILL.md'))).toBe(false);

    expect((await runCli(root, ['update'])).code).toBe(0);
    expect(await exists(path.join(root, '.claude', 'skills', 'xforge-kanban', 'SKILL.md'))).toBe(true);
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
    expect((await yamlFile<any>(root, 'xforge/lock.yaml')).xforge.version).toBe('0.7.16');
  });

  /*
   * `init` seeds the `xforge/`-root documents once and target projection never revisits them, so a
   * project initialized on an older CLI never gains a document a newer CLI now bundles. `XFORGE.md`
   * is exactly that case rather than a simulation of one.
   *
   * The seed lands under the canonical name in the project's own language. It used to seed the
   * `_cn` variant alongside, which would now re-create on every update the two-file layout `init`
   * collapses — an English `constitution.md` sitting next to the Chinese one a zh-CN project is
   * actually reading.
   */
  it('seeds a root document missing from a project initialized on an older CLI, in the project language, without touching an existing one', async () => {
    const root = await fixture();
    await rm(path.join(root, 'xforge', 'XFORGE.md'));
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);

    const dry = await runCli(root, ['update', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.json.changes).toContainEqual(expect.objectContaining({ action: 'create', path: 'xforge/XFORGE.md' }));
    expect(await exists(path.join(root, 'xforge', 'XFORGE.md'))).toBe(false);

    const result = await runCli(root, ['update']);
    expect(result.code).toBe(0);
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'create', path: 'xforge/XFORGE.md' }));
    expect(await readFile(path.join(root, 'xforge', 'XFORGE.md'), 'utf8')).toContain('# XForge project bootstrap');

    const customized = '# Our own bootstrap\n\nRead the team handbook first.\n';
    await write(root, 'xforge/XFORGE.md', customized);
    const again = await runCli(root, ['update']);
    expect(again.code).toBe(0);
    expect(again.json.changes).not.toContainEqual(expect.objectContaining({ path: 'xforge/XFORGE.md' }));
    expect(await readFile(path.join(root, 'xforge', 'XFORGE.md'), 'utf8')).toBe(customized);
  });

  it('uses update to prune a Target removed from the Manifest', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.targets = ['codex', 'claude']; });
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect(await exists(path.join(root, '.claude', 'skills', 'xforge-kanban', 'SKILL.md'))).toBe(true);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.targets = ['codex']; });

    const result = await runCli(root, ['update']);
    expect(result.code).toBe(0);
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'delete', path: '.claude/skills/xforge-kanban/SKILL.md' }));
    expect(await exists(path.join(root, '.claude', 'skills', 'xforge-kanban', 'SKILL.md'))).toBe(false);
    expect(Object.keys((await ownership(root)).targets)).toEqual(['codex']);
  });

  it('dry-runs, uninstalls one target, then removes the final installation record', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    expect((await runCli(root, ['install', '--target', 'claude'])).code).toBe(0);
    const codexPath = path.join(root, '.agents', 'skills', 'xforge-kanban', 'SKILL.md');
    const claudePath = path.join(root, '.claude', 'skills', 'xforge-kanban', 'SKILL.md');

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

  // P0-2 / P0-4: uninstall must subtract exactly what XForge added and leave the rest.
  it('uninstall restores a shared .claude/settings.json and CLAUDE.md instead of deleting them', async () => {
    const root = await fixture();
    const userSettings = { model: 'opusplan', permissions: { deny: ['Read(./.env)'] } };
    await write(root, '.claude/settings.json', `${JSON.stringify(userSettings, null, 2)}\n`);
    await write(root, 'CLAUDE.md', '# Our project\n\nRun `make dev` first.\n');
    expect((await runCli(root, ['install', '--target', 'claude'])).code).toBe(0);
    expect(JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8')).hooks).toBeDefined();

    const result = await runCli(root, ['uninstall', '--target', 'claude']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    expect(JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'))).toEqual(userSettings);
    const memory = await readFile(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(memory).toContain('Run `make dev` first.');
    expect(memory).not.toContain('@AGENTS.md');
  });

  it('uninstall deletes a shared file it created and left nothing else in', async () => {
    const root = await fixture();
    await write(root, 'xforge/scaffold/policies/no-force-push.yaml', [
      'apiVersion: xforge.dev/v1alpha2', 'kind: PermissionPolicy', 'metadata:', '  name: no-force-push', '  version: 1',
      'spec:', '  capability: shell', '  effect: deny', '  match:', '    commands:', '      - git push --force *',
      '  reason: Force pushes are forbidden.', '',
    ].join('\n'));
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.policies.push('no-force-push'); });
    expect((await runCli(root, ['install'])).code).toBe(0);

    // The one statically expressible policy reaches OpenCode as a real `permission` object.
    expect(JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'))).toEqual({
      $schema: 'https://opencode.ai/config.json',
      permission: { bash: { 'git push --force *': 'deny' } },
    });
    expect(await exists(path.join(root, 'CLAUDE.md'))).toBe(true);

    expect((await runCli(root, ['uninstall'])).code).toBe(0);
    expect(await exists(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(await exists(path.join(root, '.claude', 'settings.json'))).toBe(false);
    // Nothing but the `$schema` seed XForge itself wrote would remain, so the file goes too.
    expect(await exists(path.join(root, 'opencode.json'))).toBe(false);
  });

  // The same reduction, on a file the project committed itself: identical contents, opposite
  // outcome. Deleting it used to be inferred from the recorded seed, which the adapter sets on
  // every descriptor — so this exact file (OpenCode's documented minimal config, and byte for byte
  // what the seed would have written) was destroyed by `uninstall` with no conflict and no backup.
  // Provenance now comes from the record, not from the contents. See install-ownership-safety.test.ts
  // for the rest of the class, including the empty-placeholder `.claude/settings.json` variant.
  it('uninstall keeps a shared file the project already had, even when nothing but its own contents remain', async () => {
    const root = await fixture();
    await write(root, 'xforge/scaffold/policies/no-force-push.yaml', [
      'apiVersion: xforge.dev/v1alpha2', 'kind: PermissionPolicy', 'metadata:', '  name: no-force-push', '  version: 1',
      'spec:', '  capability: shell', '  effect: deny', '  match:', '    commands:', '      - git push --force *',
      '  reason: Force pushes are forbidden.', '',
    ].join('\n'));
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.policies.push('no-force-push'); });
    const minimal = { $schema: 'https://opencode.ai/config.json' };
    await write(root, 'opencode.json', `${JSON.stringify(minimal, null, 2)}\n`);
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await ownership(root)).targets.opencode.files['opencode.json'].fragment.createdByXForge).toBe(false);

    const result = await runCli(root, ['uninstall']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    expect(await exists(path.join(root, 'opencode.json'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'))).toEqual(minimal);
  });

  // P1-2: an unsupported Hook event used to be dropped by a bare `continue`, with the declared
  // capability matrix never consulted by anything.
  it('reports a Hook event a target cannot deliver instead of dropping it silently', async () => {
    const root = await fixture();
    await write(root, 'xforge/scaffold/hooks/session-audit.yaml', [
      'apiVersion: xforge.dev/v1alpha2', 'kind: Hook', 'metadata:', '  name: session-audit', '  version: 1',
      'spec:', '  enabled: true', '  plane: runtime', '  event: agent.session.start',
      '  action: { builtin: audit }', '  failurePolicy: warn', '  timeoutSeconds: 5', '',
    ].join('\n'));
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.hooks.push('session-audit'); });

    const result = await runCli(root, ['install']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    const unsupported = result.json.diagnostics.filter((item: any) => item.code === 'XFORGE_HOOK_EVENT_UNSUPPORTED');
    // OpenCode's plugin bridge only receives tool execute events.
    expect(unsupported.map((item: any) => item.details.target)).toEqual(['opencode']);
    expect(unsupported[0].severity).toBe('warning');
    expect(unsupported[0].details.event).toBe('agent.session.start');
    // Targets that do support it still get the hook.
    expect(JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart).toHaveLength(1);
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
