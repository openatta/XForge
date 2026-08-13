import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION } from '../../src/constants.js';
import { fixture, runCli, updateYaml, yamlFile } from '../helpers.js';

async function pinToOldVersion(root: string): Promise<void> {
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
    manifest.xforge.version = '0.0.1';
    manifest.scaffold.version = '0.0.1';
    manifest.scaffold.source.version = '0.0.1';
  });
}

describe('controlled upgrade channel', () => {
  it('lifts an older declared CLI identity to the running version via update', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    await pinToOldVersion(root);

    /* Before: portable and hard-blocked, with `xforge update` as the suggested way out. */
    const before = await runCli(root, ['install']);
    expect(before.code).toBe(1);
    expect(before.json.nextActions[0].action).toBe('run-upgrade');
    expect(before.json.nextActions[0].command).toEqual(['xforge', 'update']);

    const result = await runCli(root, ['update']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: 'xforge/manifest.yaml', source: 'xforge:upgrade' }));

    const manifest = await yamlFile<any>(root, 'xforge/manifest.yaml');
    expect(manifest.xforge.version).toBe(CLI_VERSION);
    expect(manifest.scaffold.version).toBe(CLI_VERSION);
    expect(manifest.scaffold.source.version).toBe(CLI_VERSION);
    expect((await yamlFile<any>(root, 'xforge/lock.yaml')).xforge.version).toBe(CLI_VERSION);

    /* After: managed again, no identity diagnostics. */
    const after = await runCli(root, ['state']);
    expect(after.code, JSON.stringify(after.json.diagnostics, null, 2)).toBe(0);
    expect(after.json.data.project.compatibility.mode).toBe('managed');
  });

  it('preserves manifest comments while bumping only the release-stamped pins', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    await pinToOldVersion(root);
    await appendFile(path.join(root, 'xforge', 'manifest.yaml'), '# project-specific note: do not remove\n');

    const result = await runCli(root, ['update']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);

    const text = await readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8');
    expect(text).toContain('# project-specific note: do not remove');
    expect(text).toContain(`version: ${CLI_VERSION}`);
  });

  it('dry-run shows the upgrade without writing the manifest', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    await pinToOldVersion(root);

    const dry = await runCli(root, ['update', '--dry-run']);
    expect(dry.code, JSON.stringify(dry.json.diagnostics, null, 2)).toBe(0);
    expect(dry.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: 'xforge/manifest.yaml' }));
    expect((await yamlFile<any>(root, 'xforge/manifest.yaml')).xforge.version).toBe('0.0.1');
  });

  it('rejects a downgrade with the exact-version install path', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.xforge.version = '9.9.9'; });

    const result = await runCli(root, ['update']);
    expect(result.code).toBe(1);
    expect(result.json.changes).toEqual([]);
    expect(result.json.nextActions[0].action).toBe('resolve-declared-xforge');
    expect((await yamlFile<any>(root, 'xforge/manifest.yaml')).xforge.version).toBe('9.9.9');

    /* Other write commands keep the same hard block, without the upgrade suggestion. */
    const install = await runCli(root, ['install']);
    expect(install.code).toBe(1);
    expect(install.json.nextActions[0].action).toBe('resolve-declared-xforge');
  });

  it('rejects an upgrade across protocol versions', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.xforge.version = '0.0.1';
      manifest.xforge.protocol = '1';
    });

    const result = await runCli(root, ['update']);
    expect(result.code).toBe(1);
    expect(result.json.nextActions[0].action).toBe('resolve-declared-xforge');
    expect((await yamlFile<any>(root, 'xforge/manifest.yaml')).xforge.version).toBe('0.0.1');
  });

  it('refuses an upgrade on a never-installed project without touching the manifest', async () => {
    const root = await fixture();
    await pinToOldVersion(root);

    /* The upgrade would be legal identity-wise, but there is no installation record — the
       command must fail before writing the version pins, not after (partial write). */
    const result = await runCli(root, ['update']);
    expect(result.code).toBe(1);
    expect(result.json.changes).toEqual([]);
    expect(result.json.diagnostics.map((item: { code: string }) => item.code)).toContain('XFORGE_NOT_INSTALLED');
    expect(result.json.nextActions[0].action).toBe('install');
    expect((await yamlFile<any>(root, 'xforge/manifest.yaml')).xforge.version).toBe('0.0.1');
  });

  it('fails loudly instead of silently skipping a version pin whose shape drifted', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    await pinToOldVersion(root);

    /* A blank line right after the `xforge:` header keeps the YAML valid (blank lines are legal
       inside block mappings) but stops the anchored block capture dead, so the version pin can
       no longer be located in the expected shape. */
    const manifestPath = path.join(root, 'xforge', 'manifest.yaml');
    const text = await readFile(manifestPath, 'utf8');
    const broken = text.replace('xforge:\n', 'xforge:\n\n');
    await writeFile(manifestPath, broken);

    const result = await runCli(root, ['update']);
    expect(result.code).toBe(1);
    expect(result.json.changes).toEqual([]);
    expect(result.json.diagnostics.map((item: { code: string }) => item.code)).toContain('XFORGE_MANIFEST_VERSION_FIELD_NOT_FOUND');
    expect(await readFile(manifestPath, 'utf8')).toBe(broken);
  });
});
