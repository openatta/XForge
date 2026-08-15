import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli, updateYaml, yamlFile } from '../helpers.js';

describe('CLI protocol', () => {
  it('emits exactly one JSON document on stdout and nothing on stderr', async () => {
    const root = await fixture();
    for (const args of [['state'], ['install', '--dry-run'], ['check']] as string[][]) {
      const result = await runCli(root, args);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({ protocolVersion: '2', command: args[0], root, diagnostics: expect.any(Array), changes: expect.any(Array), nextActions: expect.any(Array) });
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(result.stdout.trim().endsWith('}')).toBe(true);
    }
  });

  it('keeps text mode execution and status semantics aligned with JSON', async () => {
    const root = await fixture();
    const json = await runCli(root, ['state']);
    const text = await runCli(root, ['state', '--text']);
    expect(text.code).toBe(json.code);
    expect(text.stdout).toContain(`XForge state: ${json.json.ok ? 'OK' : 'FAILED'}`);
    expect(text.stdout).toContain(`Root: ${root}`);
    expect(text.stderr).toBe('');
  });

  it('exposes help/version without a project and rejects unknown commands', async () => {
    const root = await fixture();
    const help = await runCli(root, ['help', 'sync']);
    expect(help.code).toBe(0);
    expect(help.json.root).toBeNull();
    expect(help.json.data.commandHelp.usage).toContain('xforge');
    expect(help.json.data.commandHelp.usage).toContain('sync');
    const version = await runCli(root, ['version']);
    expect(version.code).toBe(0);
    expect(version.json.data).toMatchObject({ name: '@xforge/cli', version: '0.7.9', protocolVersion: '2' });

    const result = await runCli(root, ['frobnicate']);
    expect(result.code).toBe(1);
    expect(result.json.command).toBe('frobnicate');
    expect(result.json.diagnostics[0].code).toBe('XFORGE_COMMAND_UNKNOWN');
  });

  /*
   * `nextActions` used to stamp `authority: 'planning-write'` on every create-artifact Action, so a
   * check-stage Artifact was advertised under the wrong authority while its Stage declares
   * assurance-write. The Stage Skills tell the Agent to match an Action's authority before acting on
   * it, which against a constant is not a match at all. The value now comes from the Flow Stage that
   * produces the Artifact.
   */
  it('reads a create-artifact Action authority from the Stage that produces the Artifact', async () => {
    async function nextArtifactAction(remove: string[]): Promise<any> {
      const root = await fixture();
      await createCompleteSolidChange(root);
      for (const relative of remove) await rm(path.join(root, 'xforge', 'changes', 'add-feature', relative));
      expect((await runCli(root, ['install'])).code).toBe(0);
      const state = await runCli(root, ['state', '--change', 'add-feature']);
      return state.json.nextActions.find((item: any) => item.action === 'create-artifact');
    }

    const planning = await nextArtifactAction(['design.md', 'check-report.md']);
    expect(planning).toMatchObject({ id: 'design', authority: 'planning-write' });

    /* Same Action shape, same Flow, different Stage — so a different authority. */
    const assurance = await nextArtifactAction(['check-report.md']);
    expect(assurance).toMatchObject({ id: 'check-report', authority: 'assurance-write' });
  });

  it('reports Portable state and blocks writes when CLI identity mismatches', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.xforge.version = '9.9.9'; });
    const state = await runCli(root, ['state']);
    expect(state.code).toBe(1);
    expect(state.json.data.project.compatibility.mode).toBe('portable');
    expect(state.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CLI_IDENTITY_MISMATCH');
    const install = await runCli(root, ['install']);
    expect(install.code).toBe(1);
    expect(install.json.changes).toEqual([]);
    expect(install.json.nextActions[0].action).toBe('resolve-declared-xforge');
  });

  it('rejects the removed Git-source CLI identity', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.xforge = { source: 'git', repository: 'https://example.test/xforge.git', commit: '0123456789abcdef0123456789abcdef01234567', path: 'xforge', protocol: '2' };
    });
    const result = await runCli(root, ['state']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_SCHEMA_INVALID');
  });

  it('lets update reconcile an older-but-Protocol-compatible declared CLI version, never install/check/sync', async () => {
    const root = await fixture();
    /* `update` (unlike `install`) requires an existing installation record, so this simulates a
       real upgrade: install cleanly at the current version first, then roll the declared version
       back to simulate a project whose Manifest lagged behind the CLI it's now running under. */
    const initialInstall = await runCli(root, ['install']);
    expect(initialInstall.code, JSON.stringify(initialInstall.json.diagnostics)).toBe(0);
    /* `updateYaml` round-trips through the `yaml` library with `sortMapEntries: true`, so this
       also exercises reconcileDeclaredCliVersion's key-order independence (see project-loader.ts) —
       not just the happy-path field values. */
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.xforge.version = '0.7.7';
      manifest.scaffold.version = '0.7.7';
      manifest.scaffold.source.version = '0.7.7';
    });

    const blockedInstall = await runCli(root, ['install']);
    expect(blockedInstall.code).toBe(1);
    expect(blockedInstall.json.nextActions[0]).toMatchObject({ action: 'resolve-declared-xforge', command: ['xforge', 'update'] });

    const blockedCheck = await runCli(root, ['check']);
    expect(blockedCheck.code).toBe(1);

    const dryRun = await runCli(root, ['update', '--dry-run']);
    expect(dryRun.code).toBe(0);
    expect(dryRun.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: 'xforge/manifest.yaml' }));
    const stillOld = await readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8');
    expect(stillOld).toContain('0.7.7');

    const update = await runCli(root, ['update']);
    expect(update.code, JSON.stringify(update.json.diagnostics)).toBe(0);
    expect(update.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: 'xforge/manifest.yaml', source: 'xforge:declared-version-upgrade:0.7.7->0.7.9' }));
    const manifest = await yamlFile(root, 'xforge/manifest.yaml');
    expect(manifest.xforge.version).toBe('0.7.9');
    expect(manifest.scaffold.version).toBe('0.7.9');
    expect(manifest.scaffold.source.version).toBe('0.7.9');

    const state = await runCli(root, ['state']);
    expect(state.code).toBe(0);
    expect(state.json.data.project.compatibility.mode).toBe('managed');
  });

  it('never lets update treat a newer declared version as a downgrade to reconcile', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.xforge.version = '9.9.9';
      manifest.scaffold.version = '9.9.9';
      manifest.scaffold.source.version = '9.9.9';
    });
    const update = await runCli(root, ['update']);
    expect(update.code).toBe(1);
    expect(update.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CLI_IDENTITY_MISMATCH');
    const manifest = await yamlFile(root, 'xforge/manifest.yaml');
    expect(manifest.xforge.version).toBe('9.9.9');
  });

  it('never lets update reconcile across a Protocol mismatch even when the version is older', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.xforge.version = '0.7.7';
      manifest.scaffold.version = '0.7.7';
      manifest.scaffold.source.version = '0.7.7';
      manifest.xforge.protocol = '1';
    });
    const update = await runCli(root, ['update']);
    expect(update.code).toBe(1);
    expect(update.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_PROTOCOL_MISMATCH');
    const manifest = await yamlFile(root, 'xforge/manifest.yaml');
    expect(manifest.xforge.version).toBe('0.7.7');
  });
});
