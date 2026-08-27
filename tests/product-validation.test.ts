import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, repositoryRoot, runCli, xforgeRoot } from '../xforge/test/helpers.js';

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

    /* Derived from the manifest the runtime itself reads, not a hand-maintained list: the literal
       list had drifted to twelve entries — three Skills that no longer ship and none for
       xforge-kanban — so it asserted the shape of a Scaffold that did not exist while leaving a
       shipped Skill unchecked. Reading the manifest makes adding or removing a Skill move this
       assertion with it. */
    const manifest = await readFile(path.join(scaffold, 'payload', 'xforge', 'manifest.yaml'), 'utf8');
    const ids = [...manifest.matchAll(/^\s+- (xforge-[a-z-]+)$/gm)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const skill = await readFile(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'skills', id, 'SKILL.md'), 'utf8');
      const chinese = await readFile(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'skills', id, 'SKILL_cn.md'), 'utf8');
      for (const heading of ['# Invariants', '# Authority', '# Execution', '# Evidence', '# Stop and rework']) expect(skill).toContain(heading);
      for (const heading of ['# 不变量', '# 权限', '# 执行', '# 证据', '# 停止与返工']) expect(chinese).toContain(heading);
      for (const variant of [skill, chinese]) {
        expect(variant).toContain('xforge state');
        expect(variant).not.toMatch(/`openspec\s/);
        /* Attribution lives once in scaffold/NOTICE, not repeated per file; frontmatter carries
           only what a host or the CLI actually reads. */
        expect(variant).not.toMatch(/^license:/m);
        expect(variant).not.toMatch(/^metadata:/m);
        expect(variant).toMatch(/^allowed-tools: .+$/m);
      }
    }
    const apply = await readFile(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'skills', 'xforge-apply', 'SKILL.md'), 'utf8');
    const applyChinese = await readFile(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'skills', 'xforge-apply', 'SKILL_cn.md'), 'utf8');
    expect(apply).toContain('work-packages.yaml');
    expect(apply).toContain('Run Workers in parallel');
    expect(applyChinese).toContain('并行激活 Worker');
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'flows', 'major.yaml'))).toBe(true);
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'flows', 'prime.yaml'))).toBe(false);
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'flows', 'macro.yaml'))).toBe(false);

    for (const id of ['worker', 'integrator', 'reviewer']) {
      expect(await exists(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'agents', `${id}.yaml`))).toBe(true);
      expect(await exists(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'agents', `${id}.md`))).toBe(true);
      expect(await exists(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'agents', `${id}_cn.md`))).toBe(true);
    }
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'agents', 'primary.yaml'))).toBe(false);
    expect(await exists(path.join(scaffold, 'payload', 'xforge', 'scaffold', 'agents', 'tester.yaml'))).toBe(false);
    expect(await readFile(path.join(scaffold, 'payload', 'xforge', 'constitution.md'), 'utf8')).toContain('## Parallel Development');
    /*
     * The bootstrap text lives in `xforge/XFORGE.md` now, bilingual like every other document the
     * Agent reads. `AGENTS.md` keeps only a pointer to it, so a repository that already maintains
     * its own `AGENTS.md` receives four lines rather than thirty-five, and XForge can revise the
     * bootstrap without editing a file the project owns.
     */
    const agents = await readFile(path.join(scaffold, 'payload', 'AGENTS.md'), 'utf8');
    expect(agents).toContain('xforge/XFORGE.md');
    expect(agents).not.toContain('work-packages.yaml');
    for (const variant of ['XFORGE.md', 'XFORGE_cn.md']) {
      const bootstrap = await readFile(path.join(scaffold, 'payload', 'xforge', variant), 'utf8');
      expect(bootstrap).toContain('work-packages.yaml');
      expect(bootstrap).toContain('--no-install');
    }
  });

  it('bundles the exact verified Scaffold inside the npm CLI package', async () => {
    const canonical = path.join(repositoryRoot, 'scaffold');
    const bundled = path.join(xforgeRoot, 'scaffold');
    expect(await exists(path.join(bundled, 'scaffold.yaml'))).toBe(true);
    expect(await readFile(path.join(bundled, 'scaffold.yaml'), 'utf8')).toBe(await readFile(path.join(canonical, 'scaffold.yaml'), 'utf8'));
    expect(await readFile(path.join(bundled, 'files.sha256'), 'utf8')).toBe(await readFile(path.join(canonical, 'files.sha256'), 'utf8'));
    expect(await payloadDigest(path.join(bundled, 'payload'))).toBe(await readFile(path.join(canonical, 'files.sha256'), 'utf8'));
    const manifest = await readFile(path.join(bundled, 'payload', 'xforge', 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('type: npm');
    expect(manifest).toContain('package: "@xforge/cli"');
    expect(manifest).not.toContain('type: git');
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
    expect(await exists(path.join(root, '.codex', 'agents', 'worker.toml'))).toBe(true);
    expect(installed.json.data.capabilities.codex.commands).toBe('unsupported');
    expect(installed.json.data.capabilities.codex.agents).toBe('native');
    expect(installed.json.data.capabilities.claude.commands).toBe('native');
  });

  /*
   * This used to assert a mutually linked pair of READMEs, English at the root and Chinese under
   * `docs/`. The docs set is now Chinese-only and organised as five core documents behind
   * `docs/index.md`, so the pair no longer exists and the language switcher at the top of the root
   * README would point at a file that does not.
   *
   * What replaces it is a stronger property than the old headings check, not a weaker one. The pair
   * test could only see that two files existed and each carried four headings; it could not see a
   * document added or renamed without being indexed, which is the way a docs set actually rots.
   * Reachability from both entry points, plus existence on disk, catches that.
   */
  it('ships one Chinese README linked to a complete Chinese docs set plus an Agent installation runbook', async () => {
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const index = await readFile(path.join(repositoryRoot, 'docs', 'index.md'), 'utf8');
    const runbook = await readFile(path.join(repositoryRoot, 'AGENT_INSTALL.md'), 'utf8');
    expect(readme.startsWith('# XForge\n')).toBe(true);
    /* No English counterpart to switch to, and `docs/README.md` is archived under `docs/internal/`.
       A leftover switcher is a link to a file that no longer exists, so it is a failure here. */
    expect(readme).not.toMatch(/^English \| /);
    expect(readme).not.toContain('docs/README.md');
    for (const heading of ['## 概念', '## 安装', '## 使用', '## 维护与升级']) {
      expect(readme).toContain(heading);
    }
    const coreDocs = [
      'concepts-and-architecture.md',
      'governance-model.md',
      'extension-guide.md',
      'repository-layout.md',
      'sub-agent-design.md',
      'cli-tool-usage.md',
    ];
    expect(readme).toContain('docs/index.md');
    for (const document of coreDocs) {
      expect(await exists(path.join(repositoryRoot, 'docs', document))).toBe(true);
      expect(readme).toContain(`docs/${document}`);
      expect(index).toContain(`(${document})`);
    }
    expect(runbook).toContain('npm install --save-dev --save-exact @xforge/cli');
    expect(runbook).toContain('xforge init');
    expect(runbook).toContain('xforge install --target');
    expect(runbook).not.toContain('install from source');
    expect(runbook).toContain('## Acceptance criteria');
  });

  it('publishes only the public scoped CLI package with release safeguards', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
    const cliPackage = JSON.parse(await readFile(path.join(xforgeRoot, 'package.json'), 'utf8'));
    const packageReadme = await readFile(path.join(xforgeRoot, 'README.md'), 'utf8');
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'publish-npm.yml'), 'utf8');
    expect(rootPackage.private).toBe(true);
    expect(cliPackage.name).toBe('@xforge/cli');
    expect(cliPackage.version).toBe('0.7.21');
    expect(cliPackage.files).toContain('scaffold');
    expect(cliPackage.publishConfig).toEqual({ access: 'public', registry: 'https://registry.npmjs.org/' });
    expect(cliPackage.scripts.prepublishOnly).toBe('npm run verify');
    expect(packageReadme).toContain('npm install --save-dev --save-exact @xforge/cli@0.7.21');
    expect(packageReadme).toContain('xforge init --target codex');
    expect(packageReadme).not.toMatch(/npm install[^\n]*(?:file:|git\+)/);
    expect(packageReadme).toContain('/blob/v0.7.21/AGENT_INSTALL.md');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('working-directory: xforge');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });
});
