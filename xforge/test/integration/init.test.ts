import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, temporaryDirectory } from '../helpers.js';

async function emptyProject(): Promise<string> {
  return temporaryDirectory('xforge-init-test-');
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

describe('npm-bundled project initialization', () => {
  it('plans initialization without writing during dry run', async () => {
    const root = await emptyProject();
    const result = await runCli(root, ['init', '--language', 'en', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.json.command).toBe('init');
    expect(result.json.data.scaffold).toMatchObject({ package: '@xforge/cli', version: '0.6.1' });
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'create', path: 'xforge/manifest.yaml' }));
    expect(await exists(path.join(root, 'xforge'))).toBe(false);
  });

  it('initializes the project before projecting a selected target', async () => {
    const root = await emptyProject();
    const initialized = await runCli(root, ['init', '--language', 'en']);
    expect(initialized.code).toBe(0);
    expect(await exists(path.join(root, 'xforge', 'manifest.yaml'))).toBe(true);
    expect(await exists(path.join(root, '.agents'))).toBe(false);

    const installed = await runCli(root, ['install', '--target', 'codex']);
    expect(installed.code).toBe(0);
    expect(await exists(path.join(root, '.agents', 'skills', 'xforge-explore', 'SKILL.md'))).toBe(true);
  });

  it('combines initialization and one target projection', async () => {
    const root = await emptyProject();
    const result = await runCli(root, ['init', '--language', 'en', '--target', 'claude']);
    expect(result.code).toBe(0);
    expect(result.json.data.projection.targets).toEqual(['claude']);
    expect(await exists(path.join(root, 'xforge', 'manifest.yaml'))).toBe(true);
    expect(await exists(path.join(root, '.claude', 'skills', 'xforge-explore', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(true);
  });

  it('pins an explicit Chinese language and projects only Chinese Agent and Skill entries', async () => {
    const root = await emptyProject();
    const result = await runCli(root, ['init', '--language', 'zh-CN', '--target', 'codex']);
    expect(result.code).toBe(0);
    expect(result.json.data.scaffold.language).toBe('zh-CN');
    const manifest = await readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('language: zh-CN');
    expect(await exists(path.join(root, 'xforge', 'scaffold', 'skills', 'xforge-apply', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(root, 'xforge', 'scaffold', 'skills', 'xforge-apply', 'SKILL_cn.md'))).toBe(true);
    const installedSkill = await readFile(path.join(root, '.agents', 'skills', 'xforge-apply', 'SKILL.md'), 'utf8');
    expect(installedSkill).toContain('# 不变量');
    expect(await exists(path.join(root, '.agents', 'skills', 'xforge-apply', 'SKILL_cn.md'))).toBe(false);
    const installedWorker = await readFile(path.join(root, '.codex', 'agents', 'worker.toml'), 'utf8');
    expect(installedWorker).toContain('只执行一个已分配的 XForge 工作包');
  });

  it('requires an explicit choice when locale detection is unavailable non-interactively', async () => {
    const root = await emptyProject();
    const result = await runCli(root, ['init'], { XFORGE_LANGUAGE: '', LC_ALL: '', LC_MESSAGES: '', LANG: 'C' });
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_LANGUAGE_REQUIRED');
    expect(result.json.nextActions).toContainEqual(expect.objectContaining({ action: 'select-language', actor: 'human' }));
    expect(await exists(path.join(root, 'xforge'))).toBe(false);
  });

  it('preflights target conflicts before writing the Scaffold', async () => {
    const root = await emptyProject();
    const destination = path.join(root, '.agents', 'skills', 'xforge-explore', 'SKILL.md');
    await writeFile(path.join(root, 'placeholder'), 'project\n');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'human-owned\n');
    const result = await runCli(root, ['init', '--language', 'en', '--target', 'codex']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INSTALL_CONFLICT');
    expect(await exists(path.join(root, 'xforge', 'manifest.yaml'))).toBe(false);
    expect(await readFile(destination, 'utf8')).toBe('human-owned\n');
  });

  it('does not overwrite a conflicting project file', async () => {
    const root = await emptyProject();
    await writeFile(path.join(root, 'AGENTS.md'), 'project-owned\n');
    const result = await runCli(root, ['init', '--language', 'en']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INIT_CONFLICT');
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('project-owned\n');
    expect(await exists(path.join(root, 'xforge'))).toBe(false);
  });
});
