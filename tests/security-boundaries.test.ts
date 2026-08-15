import { access, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../xforge/test/helpers.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

describe('black-box security boundaries', () => {
  it('fails illegal and overlapping logical paths before any generated write', async () => {
    for (const paths of [
      { specs: '../outside', changes: 'xforge/changes' },
      { specs: 'docs', changes: 'docs/changes' },
      { specs: '.claude/specs', changes: 'docs/changes' },
    ]) {
      const root = await fixture();
      await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.project.paths = paths; });
      const result = await runCli(root, ['install']);
      expect(result.code).toBe(1);
      expect(result.json.changes).toEqual([]);
      expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(false);
      expect(await exists(path.join(root, '.agents'))).toBe(false);
    }
  });

  it('rejects malicious resource names at Schema validation', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.skills = ['../../escape']; });
    const result = await runCli(root, ['install']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_SCHEMA_INVALID');
    expect(result.json.changes).toEqual([]);
  });

  it('refuses a generated destination redirected through a symlink', async () => {
    const root = await fixture();
    const outside = await fixture('xforge-security-outside-');
    await symlink(outside, path.join(root, '.agents'));
    const result = await runCli(root, ['install', '--target', 'codex']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_SYMLINK_ESCAPE');
    expect(await exists(path.join(outside, 'skills'))).toBe(false);
  });

  it('does not leak declared secret-like values in a protocol file', async () => {
    const root = await fixture();
    await write(root, 'xforge/scaffold/hooks/acme-hook.yaml', [
      'apiVersion: xforge.dev/v1alpha1', 'kind: Hook', 'metadata:', '  name: acme-hook', 'spec:',
      '  enabled: false', '  event: before.write', '  command: [node, hook.js]', '  timeoutSeconds: 10',
      '  workingDirectory: .', '  permissions: [read]', '  failurePolicy: stop', '  network: false', '',
    ].join('\n'));
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.scaffold.hooks = ['acme-hook'];
      manifest.apiToken = 'do-not-store-this';
    });
    const result = await runCli(root, ['state']);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('do-not-store-this');
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_SCHEMA_INVALID');
  });

  it('blocks secret-like material before copying a Skill into generated targets', async () => {
    const root = await fixture();
    const skillPath = 'xforge/scaffold/skills/xforge-kanban/SKILL.md';
    const source = await readFile(path.join(root, ...skillPath.split('/')), 'utf8');
    await write(root, skillPath, `${source}\napi_key=supersecretvalue\n`);
    const result = await runCli(root, ['install', '--target', 'codex']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_SECRET_IN_GENERATED_CONTENT');
    expect(await exists(path.join(root, '.agents'))).toBe(false);
  });

  it('rejects a work-package input redirected outside the project', async () => {
    const root = await fixture();
    const outside = await fixture('xforge-work-package-outside-');
    await createCompleteSolidChange(root);
    await symlink(path.join(outside, 'AGENTS.md'), path.join(root, 'outside-input.md'));
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', [
      'apiVersion: xforge.dev/v1alpha1',
      'kind: WorkPackagePlan',
      'packages:',
      '  - id: T001',
      '    goal: Reject escaped inputs',
      '    depends_on: []',
      '    inputs: [outside-input.md]',
      '    write_paths: [src/order/**]',
      '    skills: [xforge-apply]',
      '    verify: ["node -e \\\"process.exit(0)\\\""]',
      '    done_when: [Escaped inputs are rejected]',
      '',
    ].join('\n'));

    const result = await runCli(root, ['state', '--change', 'add-feature']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_SYMLINK_ESCAPE');
  });
});
