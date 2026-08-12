import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, scaffoldPayload, temporaryDirectory, write } from '../helpers.js';

const BEGIN = '<!-- XFORGE:BEGIN -->';
const END = '<!-- XFORGE:END -->';

async function emptyProject(): Promise<string> {
  return temporaryDirectory('xforge-init-test-');
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function bundledAgents(): Promise<string> {
  return readFile(path.join(scaffoldPayload, 'AGENTS.md'), 'utf8');
}

/** The bundled managed block, markers included — the exact bytes `init` owns inside AGENTS.md. */
async function bundledBlock(): Promise<string> {
  const text = await bundledAgents();
  return text.slice(text.indexOf(BEGIN), text.indexOf(END) + END.length);
}

describe('npm-bundled project initialization', () => {
  it('plans initialization without writing during dry run', async () => {
    const root = await emptyProject();
    const result = await runCli(root, ['init', '--language', 'en', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.json.command).toBe('init');
    expect(result.json.data.scaffold).toMatchObject({ package: '@xforge/cli', version: '0.7.8' });
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
    await write(root, 'xforge/constitution.md', 'project-owned\n');
    const result = await runCli(root, ['init', '--language', 'en']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INIT_CONFLICT');
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'conflict', path: 'xforge/constitution.md' }));
    expect(await readFile(path.join(root, 'xforge', 'constitution.md'), 'utf8')).toBe('project-owned\n');
    expect(await exists(path.join(root, 'xforge', 'manifest.yaml'))).toBe(false);
  });
});

describe('AGENTS.md marker-block merge', () => {
  it('creates AGENTS.md with the managed marker block when none exists', async () => {
    const root = await emptyProject();
    const result = await runCli(root, ['init', '--language', 'en']);
    expect(result.code).toBe(0);
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'create', path: 'AGENTS.md' }));
    const written = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(written).toBe(await bundledAgents());
    expect(written).toContain(BEGIN);
    expect(written).toContain(END);
    expect(written).toContain('work-packages.yaml');
  });

  it('preserves an existing markerless AGENTS.md verbatim and appends the managed block', async () => {
    const root = await emptyProject();
    const original = '# Team agent guide\n\nRun `make test` before pushing.\n';
    await writeFile(path.join(root, 'AGENTS.md'), original);
    const result = await runCli(root, ['init', '--language', 'en']);
    expect(result.code).toBe(0);
    expect(result.json.diagnostics).toEqual([]);
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: 'AGENTS.md' }));
    const merged = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(merged.startsWith(original)).toBe(true);
    expect(merged).toBe(`${original}\n${await bundledBlock()}\n`);
    expect(await exists(path.join(root, 'xforge', 'manifest.yaml'))).toBe(true);
  });

  it('separates the appended block when the existing AGENTS.md has no trailing newline', async () => {
    const root = await emptyProject();
    const original = 'no trailing newline here';
    await writeFile(path.join(root, 'AGENTS.md'), original);
    const result = await runCli(root, ['init', '--language', 'en']);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe(`${original}\n\n${await bundledBlock()}\n`);
  });

  it('reports the merged AGENTS.md digest that matches what lands on disk', async () => {
    const root = await emptyProject();
    await writeFile(path.join(root, 'AGENTS.md'), 'project-owned\n');
    const result = await runCli(root, ['init', '--language', 'en']);
    const change = result.json.changes.find((item: any) => item.path === 'AGENTS.md');
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(await readFile(path.join(root, 'AGENTS.md'))).digest('hex');
    expect(change.digest).toBe(digest);
  });

  it('is a no-op when init runs twice over a merged AGENTS.md', async () => {
    const root = await emptyProject();
    await writeFile(path.join(root, 'AGENTS.md'), 'project-owned\n');
    const first = await runCli(root, ['init', '--language', 'en']);
    expect(first.code).toBe(0);
    const merged = await readFile(path.join(root, 'AGENTS.md'), 'utf8');

    const second = await runCli(root, ['init', '--language', 'en']);
    expect(second.code).toBe(0);
    expect(second.json.changes).toEqual([]);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe(merged);
  });

  it('skips AGENTS.md when its managed block is already current', async () => {
    const root = await emptyProject();
    await writeFile(path.join(root, 'AGENTS.md'), `keep me\n\n${await bundledBlock()}\n`);
    const result = await runCli(root, ['init', '--language', 'en', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'skip', path: 'AGENTS.md' }));
  });

  it('replaces only the managed block body and keeps content outside the markers byte-for-byte', async () => {
    const root = await emptyProject();
    const head = '# House rules\n\nAlways rebase.\n\n';
    const tail = '\n\n## Local notes\n\nAsk before deleting fixtures.\n';
    await writeFile(path.join(root, 'AGENTS.md'), `${head}${BEGIN}\nstale XForge body\n${END}${tail}`);
    const result = await runCli(root, ['init', '--language', 'en']);
    expect(result.code).toBe(0);
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: 'AGENTS.md' }));
    const merged = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(merged).toBe(`${head}${await bundledBlock()}${tail}`);
    expect(merged).not.toContain('stale XForge body');
  });

  it('refuses to merge an AGENTS.md with an unterminated marker block', async () => {
    const root = await emptyProject();
    const broken = `# Guide\n\n${BEGIN}\nhalf a block\n`;
    await writeFile(path.join(root, 'AGENTS.md'), broken);
    const result = await runCli(root, ['init', '--language', 'en']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INIT_CONFLICT');
    expect(result.json.changes).toContainEqual(expect.objectContaining({ action: 'conflict', path: 'AGENTS.md' }));
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe(broken);
    expect(await exists(path.join(root, 'xforge'))).toBe(false);
  });

  it('refuses to merge an AGENTS.md with duplicated or reversed markers', async () => {
    const duplicated = await emptyProject();
    const twoBlocks = `${BEGIN}\na\n${END}\n\n${BEGIN}\nb\n${END}\n`;
    await writeFile(path.join(duplicated, 'AGENTS.md'), twoBlocks);
    const first = await runCli(duplicated, ['init', '--language', 'en']);
    expect(first.code).toBe(1);
    expect(first.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INIT_CONFLICT');
    expect(await readFile(path.join(duplicated, 'AGENTS.md'), 'utf8')).toBe(twoBlocks);

    const reversed = await emptyProject();
    const backwards = `${END}\nbody\n${BEGIN}\n`;
    await writeFile(path.join(reversed, 'AGENTS.md'), backwards);
    const second = await runCli(reversed, ['init', '--language', 'en']);
    expect(second.code).toBe(1);
    expect(second.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INIT_CONFLICT');
    expect(await readFile(path.join(reversed, 'AGENTS.md'), 'utf8')).toBe(backwards);
    expect(await exists(path.join(reversed, 'xforge'))).toBe(false);
  });

  it('merges AGENTS.md while projecting a target in the same init run', async () => {
    const root = await emptyProject();
    const original = '# Existing Codex guide\n';
    await writeFile(path.join(root, 'AGENTS.md'), original);
    const result = await runCli(root, ['init', '--language', 'en', '--target', 'codex']);
    /* Merging cleanly means no error/warning diagnostics — not zero diagnostics ever. Codex has no
       static permission-policy projection and the scaffold's example mcp approval provider is a
       placeholder, so both legitimately produce info-level visibility, not a merge problem. */
    expect(result.json.diagnostics.filter((item: any) => item.severity !== 'info')).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.json.data.projection.targets).toEqual(['codex']);
    const merged = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(merged.startsWith(original)).toBe(true);
    expect(merged).toContain(BEGIN);
    expect(await exists(path.join(root, '.agents', 'skills', 'xforge-explore', 'SKILL.md'))).toBe(true);
  });
});
