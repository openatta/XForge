import { createHash } from 'node:crypto';
import { access, cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fixture, repositoryRoot, runCli, xforgeRoot } from '../xforge/test/helpers.js';

async function command(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function payloadDigest(root: string): Promise<string> {
  const entries: string[] = [];
  async function walk(directory: string, prefix = ''): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else {
        const digest = createHash('sha256').update(await readFile(absolute)).digest('hex');
        entries.push(`${digest}  payload/${relative}`);
      }
    }
  }
  await walk(root);
  return `${entries.join('\n')}\n`;
}

describe('XForge product contract', () => {
  it('ships a stable, complete, attributed Scaffold payload', async () => {
    const scaffold = path.join(repositoryRoot, 'scaffold');
    const expected = await readFile(path.join(scaffold, 'files.sha256'), 'utf8');
    expect(await payloadDigest(path.join(scaffold, 'payload'))).toBe(expected);
    expect(expected).not.toContain('files.sha256');
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'src'))).toBe(false);
    expect(await exists(path.join(scaffold, 'payload', '.git'))).toBe(false);

    const ids = ['explore', 'propose', 'clarify', 'design', 'check', 'apply', 'verify', 'status', 'continue', 'revise', 'scaffold', 'archive'];
    for (const id of ids) {
      const skill = await readFile(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'skills', `xforge-${id}`, 'SKILL.md'), 'utf8');
      for (const heading of ['# 不变量', '# 权限', '# 执行', '# 证据', '# 停止与返工']) expect(skill).toContain(heading);
      expect(skill).toContain('OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab');
      expect(skill).toContain('xforge state');
      expect(skill).not.toMatch(/`openspec\s/);
    }
    const apply = await readFile(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'skills', 'xforge-apply', 'SKILL.md'), 'utf8');
    expect(apply).toContain('work-packages.yaml');
    expect(apply).toContain('并行激活 Worker');
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'flows', 'major.yaml'))).toBe(true);
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'flows', 'prime.yaml'))).toBe(false);
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'flows', 'macro.yaml'))).toBe(false);

    for (const id of ['worker', 'integrator', 'reviewer']) {
      expect(await exists(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'agents', `${id}.yaml`))).toBe(true);
      expect(await exists(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'agents', `${id}.md`))).toBe(true);
    }
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'agents', 'primary.yaml'))).toBe(false);
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'agents', 'tester.yaml'))).toBe(false);
    expect(await readFile(path.join(scaffold, 'payload', 'xforge', 'constitution.md'), 'utf8')).toContain('## Parallel Development');
    expect(await readFile(path.join(scaffold, 'payload', 'AGENTS.md'), 'utf8')).toContain('work-packages.yaml');
  });

  it('proves Git sparse checkout and HTTP artifact content equivalence', async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), 'xforge-dist-source-'));
    await cp(path.join(repositoryRoot, 'scaffold'), path.join(source, 'scaffold'), { recursive: true });
    await cp(path.join(repositoryRoot, 'docs'), path.join(source, 'docs'), { recursive: true });
    expect((await command('git', ['init', '-q'], source)).code).toBe(0);
    expect((await command('git', ['add', 'scaffold', 'docs'], source)).code).toBe(0);
    expect((await command('git', ['-c', 'user.name=XForge Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture'], source)).code).toBe(0);

    const cloneRoot = await mkdtemp(path.join(os.tmpdir(), 'xforge-sparse-'));
    const clonePath = path.join(cloneRoot, 'checkout');
    expect((await command('git', ['clone', '--quiet', '--filter=blob:none', '--sparse', source, clonePath], cloneRoot)).code).toBe(0);
    expect((await command('git', ['sparse-checkout', 'set', 'scaffold'], clonePath)).code).toBe(0);
    expect(await exists(path.join(clonePath, 'scaffold', 'payload', 'AGENTS.md'))).toBe(true);
    expect(await exists(path.join(clonePath, 'docs', 'bootstrap.md'))).toBe(false);

    const releaseRoot = await mkdtemp(path.join(os.tmpdir(), 'xforge-http-'));
    const build = await command(process.execPath, [path.join(xforgeRoot, 'scripts', 'build-scaffold.mjs'), releaseRoot], repositoryRoot);
    expect(build.code, build.stderr).toBe(0);
    const archive = path.join(releaseRoot, 'xforge-scaffold-0.4.1.tar.gz');
    const listing = await command('tar', ['-tzf', archive], releaseRoot);
    expect(listing.code).toBe(0);
    expect(listing.stdout.split('\n').filter(Boolean).every((entry) => entry === 'scaffold.yaml' || entry === 'files.sha256' || entry.startsWith('payload/'))).toBe(true);
    expect(await readFile(path.join(clonePath, 'scaffold', 'files.sha256'), 'utf8')).toBe(await readFile(path.join(repositoryRoot, 'scaffold', 'files.sha256'), 'utf8'));
    const archiveDigest = createHash('sha256').update(await readFile(archive)).digest('hex');
    expect(await readFile(`${archive}.sha256`, 'utf8')).toContain(archiveDigest);
  });

  it('installs assets where at least Codex and Claude actually discover Skills', async () => {
    const root = await fixture();
    const installed = await runCli(root, ['install']);
    expect(installed.code).toBe(0);
    const codexSkill = path.join(root, '.agents', 'skills', 'xforge-propose', 'SKILL.md');
    const claudeSkill = path.join(root, '.claude', 'skills', 'xforge-propose', 'SKILL.md');
    expect(await exists(codexSkill)).toBe(true);
    expect(await exists(claudeSkill)).toBe(true);
    expect(await readFile(codexSkill, 'utf8')).toBe(await readFile(claudeSkill, 'utf8'));
    expect(installed.json.data.capabilities.codex.commands).toBe('unsupported');
    expect(installed.json.data.capabilities.claude.commands).toBe('native');
  });

  it('ships mutually linked English and Chinese READMEs plus an Agent installation runbook', async () => {
    const english = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const chinese = await readFile(path.join(repositoryRoot, 'docs', 'README.md'), 'utf8');
    const runbook = await readFile(path.join(repositoryRoot, 'AGENT_INSTALL.md'), 'utf8');
    expect(english.startsWith('English | [简体中文](docs/README.md)\n')).toBe(true);
    expect(chinese.startsWith('[English](../README.md) | 简体中文\n')).toBe(true);
    for (const heading of ['## Design goals', '## Main features', '## Getting started', '## Using XForge for a change']) {
      expect(english).toContain(heading);
    }
    for (const heading of ['## 设计目标', '## 主要特性', '## 开始使用', '## 用 XForge 开发一个 Change']) {
      expect(chinese).toContain(heading);
    }
    expect(runbook).toContain('## Path A — install from source (available now)');
    expect(runbook).toContain('## Path B — install from npm');
    expect(runbook).toContain('## Acceptance criteria');
  });

  it('publishes only the public scoped CLI package with release safeguards', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
    const cliPackage = JSON.parse(await readFile(path.join(xforgeRoot, 'package.json'), 'utf8'));
    const packageReadme = await readFile(path.join(xforgeRoot, 'README.md'), 'utf8');
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'publish-npm.yml'), 'utf8');
    expect(rootPackage.private).toBe(true);
    expect(cliPackage.name).toBe('@xforge/cli');
    expect(cliPackage.version).toBe('0.4.1');
    expect(cliPackage.publishConfig).toEqual({ access: 'public', registry: 'https://registry.npmjs.org/' });
    expect(cliPackage.scripts.prepublishOnly).toBe('npm run verify');
    expect(packageReadme).toContain('npm install --save-dev --save-exact @xforge/cli@0.4.1');
    expect(packageReadme).toContain('/blob/v0.4.1/AGENT_INSTALL.md');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('working-directory: xforge');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });
});
