import { describe, expect, it } from 'vitest';
import { fixture, runCli, updateYaml } from '../helpers.js';
import { runtimeCliIntegrity } from '../../src/core/identity.js';

describe('CLI protocol', () => {
  it('emits exactly one JSON document on stdout and nothing on stderr', async () => {
    const root = await fixture();
    for (const args of [['state'], ['install', '--dry-run'], ['check']] as string[][]) {
      const result = await runCli(root, args);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({ protocolVersion: '1', command: args[0], root, diagnostics: expect.any(Array), changes: expect.any(Array), nextActions: expect.any(Array) });
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

  it('rejects a fifth command with a stable JSON diagnostic', async () => {
    const root = await fixture();
    const result = await runCli(root, ['update']);
    expect(result.code).toBe(1);
    expect(result.json.command).toBe('update');
    expect(result.json.diagnostics[0].code).toBe('XFORGE_COMMAND_UNKNOWN');
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

  it('supports Git full-commit identity through build provenance', async () => {
    const root = await fixture();
    const commit = '0123456789abcdef0123456789abcdef01234567';
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.xforge = { source: 'git', repository: 'https://example.test/xforge.git', commit, path: 'xforge', protocol: '1' };
    });
    await updateYaml(root, 'xforge/lock.yaml', (lock) => {
      lock.xforge = { source: 'git', repository: 'https://example.test/xforge.git', commit, path: 'xforge', protocol: '1', integrity: runtimeCliIntegrity() };
    });
    const mismatched = await runCli(root, ['state']);
    expect(mismatched.json.data.project.compatibility.mode).toBe('portable');
    const matched = await runCli(root, ['state'], { XFORGE_BUILD_COMMIT: commit, XFORGE_BUILD_REPOSITORY: 'https://example.test/xforge.git' });
    expect(matched.code).toBe(0);
    expect(matched.json.data.project.compatibility.mode).toBe('managed');
  });
});
