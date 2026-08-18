import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, runCli, updateYaml, write, yamlFile } from '../helpers.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function json(root: string, relative: string): Promise<any> {
  return JSON.parse(await readFile(path.join(root, ...relative.split('/')), 'utf8'));
}

const USER_SETTINGS = {
  model: 'opusplan',
  env: { MY_TEAM_FLAG: '1' },
  statusLine: { type: 'command', command: './scripts/statusline.sh' },
  claudeMdExcludes: ['**/other-team/CLAUDE.md'],
  permissions: { deny: ['Read(./.env)'], allow: ['Bash(npm run lint)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/team-guard.sh' }] }] },
};

describe('install lifecycle', () => {
  it('is dry-run safe, installs all five targets, and is idempotent', async () => {
    const root = await fixture();
    const dry = await runCli(root, ['install', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stderr).toBe('');
    expect(dry.json.ok).toBe(true);
    expect(await exists(path.join(root, '.agents'))).toBe(false);
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(false);

    const first = await runCli(root, ['install']);
    expect(first.code).toBe(0);
    expect(await exists(path.join(root, '.agents', 'skills', 'xforge-kanban', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(root, '.claude', 'commands', 'xforge', 'kanban.md'))).toBe(true);
    expect(await exists(path.join(root, '.cursor', 'commands', 'xforge-kanban.md'))).toBe(true);
    expect(await exists(path.join(root, '.opencode', 'commands', 'xforge-kanban.md'))).toBe(true);
    expect(await exists(path.join(root, '.github', 'prompts', 'xforge-kanban.prompt.md'))).toBe(true);
    expect(await exists(path.join(root, '.claude', 'agents', 'worker.md'))).toBe(true);
    expect(await exists(path.join(root, '.claude', 'agents', 'integrator.md'))).toBe(true);
    expect(await exists(path.join(root, '.claude', 'agents', 'reviewer.md'))).toBe(true);
    expect(await exists(path.join(root, '.agents', 'agents', 'worker.md'))).toBe(false);
    const stateBefore = await readFile(path.join(root, 'xforge', '.state.json'), 'utf8');
    const lockBefore = await readFile(path.join(root, 'xforge', 'lock.yaml'), 'utf8');

    const second = await runCli(root, ['install']);
    expect(second.code).toBe(0);
    expect(second.json.changes.every((item: any) => item.action === 'skip')).toBe(true);
    expect(await readFile(path.join(root, 'xforge', '.state.json'), 'utf8')).toBe(stateBefore);
    expect(await readFile(path.join(root, 'xforge', 'lock.yaml'), 'utf8')).toBe(lockBefore);
  });

  it('does not overwrite an unknown destination', async () => {
    const root = await fixture();
    const destination = '.agents/skills/xforge-kanban/SKILL.md';
    await write(root, destination, 'human-owned\n');
    const result = await runCli(root, ['install', '--target', 'codex']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INSTALL_CONFLICT');
    expect(await readFile(path.join(root, ...destination.split('/')), 'utf8')).toBe('human-owned\n');
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(false);
  });

  it('protects human modifications and only prunes digest-matching managed files', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'codex'])).code).toBe(0);
    const modified = '.agents/skills/xforge-kanban/SKILL.md';
    await write(root, modified, 'human-modified\n');
    const conflict = await runCli(root, ['install', '--target', 'codex']);
    expect(conflict.code).toBe(1);
    expect(conflict.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_MANAGED_FILE_MODIFIED');
    expect(await readFile(path.join(root, ...modified.split('/')), 'utf8')).toBe('human-modified\n');

    const cleanRoot = await fixture();
    expect((await runCli(cleanRoot, ['install', '--target', 'codex'])).code).toBe(0);
    await updateYaml(cleanRoot, 'xforge/manifest.yaml', (manifest) => {
      manifest.scaffold.skills = manifest.scaffold.skills.filter((id: string) => id !== 'xforge-kanban');
      manifest.scaffold.agents = [];
    });
    const prune = await runCli(cleanRoot, ['install', '--target', 'codex']);
    expect(prune.code).toBe(0);
    expect(prune.json.changes).toContainEqual(expect.objectContaining({ action: 'delete', path: '.agents/skills/xforge-kanban/SKILL.md' }));
    expect(await exists(path.join(cleanRoot, '.agents', 'skills', 'xforge-kanban', 'SKILL.md'))).toBe(false);
  });

  // Cursor and Copilot declare an empty `permissionPolicyScopes.capabilities`, so the shipped
  // `protected-files` policy (which carries `exceptActors: [integrator]`) never reaches the "this
  // target would otherwise have carried it" branch that reports XFORGE_POLICY_STATIC_LAYER_DEGRADED
  // for the other targets. Without an explicit diagnostic for that case, those two targets get no
  // signal at all about the policy's status - not because it is fine, but because the precondition
  // for the usual warning is never true. Assert the gap is now stated explicitly instead of silent.
  it('reports a static-layer diagnostic for exceptActors policies even on targets with no static permission projection at all', async () => {
    const root = await fixture();
    const result = await runCli(root, ['install']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    const degraded = result.json.diagnostics.filter((item: any) => item.code === 'XFORGE_POLICY_STATIC_LAYER_DEGRADED');
    for (const target of ['cursor', 'github-copilot']) {
      const forTarget = degraded.find((item: any) => item.details?.target === target && item.details?.policy === 'protected-files');
      expect(forTarget, JSON.stringify(degraded, null, 2)).toBeDefined();
      expect(forTarget.details.reason).toBe('no-static-projection');
      expect(forTarget.message).toContain('no static permission-policy projection');
    }
  });

  // Codex has no command-file and no rule-file format; OpenCode has commands but no rule files.
  // Those are structural properties of the targets, declared in PROJECTED_DIMENSIONS, and every
  // affected resource used to disappear from the projection with no diagnostic at all. One summary
  // per target and dimension is now emitted, at `info` severity: `projection.ts` refuses to apply
  // the plan when any diagnostic is an `error`, so promoting these would break install outright for
  // every Codex or OpenCode project. A drop the table did *not* declare is a different code
  // (XFORGE_ADAPTER_PROJECTION_MISSING, warning) and must not appear with today's adapters.
  it('summarises the resources targets structurally cannot project, at info severity', async () => {
    const root = await fixture();
    const manifest = await yamlFile<any>(root, 'xforge/manifest.yaml');
    const result = await runCli(root, ['install']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);

    const gaps = result.json.diagnostics.filter((item: any) => item.code === 'XFORGE_CAPABILITY_CONTENT_UNSUPPORTED');
    const gap = (target: string, dimension: string) =>
      gaps.find((item: any) => item.details?.target === target && item.details?.dimension === dimension);
    const ids = (item: any) => item.details.resources.map((resource: any) => resource.id);

    // Exactly three summaries for the whole install: codex commands, codex rules, opencode rules.
    expect(gaps.map((item: any) => `${item.details.target}:${item.details.dimension}`).sort())
      .toEqual(['codex:commands', 'codex:rules', 'opencode:rules']);
    // 12 shipped Skills and 5 shipped Rules today; the ids are cross-checked against the manifest
    // so a scaffold change moves both numbers together instead of quietly shrinking coverage.
    expect(gap('codex', 'commands').details.count).toBe(12);
    expect(ids(gap('codex', 'commands')).sort()).toEqual([...manifest.scaffold.skills].sort());
    expect(gap('codex', 'rules').details.count).toBe(5);
    expect(ids(gap('codex', 'rules')).sort()).toEqual([...manifest.scaffold.rules].sort());
    expect(gap('opencode', 'rules').details.count).toBe(5);
    expect(ids(gap('opencode', 'rules')).sort()).toEqual([...manifest.scaffold.rules].sort());

    // claude, cursor and github-copilot project every dimension; opencode projects commands; no
    // target drops an Agent, so the agents dimension never appears.
    for (const target of ['claude', 'cursor', 'github-copilot']) {
      expect(gaps.filter((item: any) => item.details?.target === target)).toEqual([]);
    }
    expect(gap('opencode', 'commands')).toBeUndefined();
    expect(gaps.filter((item: any) => item.details?.dimension === 'agents')).toEqual([]);

    // The severity guard: raising these to error would make install unusable on codex/opencode.
    for (const item of gaps) expect(item.severity).toBe('info');
    expect(result.json.diagnostics.map((item: any) => item.code)).not.toContain('XFORGE_ADAPTER_PROJECTION_MISSING');

    // The summary points at the Skill documents that exist on disk (the localized variant would be
    // named here on a zh-CN project), and the Skill content itself still installs for Codex even
    // though the command wrapper does not.
    expect(gap('codex', 'commands').details.resources).toContainEqual({
      id: 'xforge-apply', path: 'xforge/scaffold/skills/xforge-apply/SKILL.md',
    });
    expect(gap('codex', 'commands').message).toContain('install without a command entry point');
    expect(await exists(path.join(root, '.agents', 'skills', 'xforge-apply', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(root, '.opencode', 'commands', 'xforge-apply.md'))).toBe(true);
  });
});

// P0-2: `.claude/settings.json` is the normal home for a team's own Claude Code settings. Taking
// the whole file made `install` fail outright on any repository already using Claude Code, and
// froze the file afterwards.
describe('partially owned host configuration', () => {
  it('installs into a pre-existing .claude/settings.json and keeps every key XForge does not own', async () => {
    const root = await fixture();
    await write(root, '.claude/settings.json', `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);

    const result = await runCli(root, ['install', '--target', 'claude']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    expect(result.json.diagnostics.map((item: any) => item.code)).not.toContain('XFORGE_INSTALL_CONFLICT');

    const settings = await json(root, '.claude/settings.json');
    expect(settings.model).toBe('opusplan');
    expect(settings.env).toEqual({ MY_TEAM_FLAG: '1' });
    expect(settings.statusLine).toEqual(USER_SETTINGS.statusLine);
    expect(settings.claudeMdExcludes).toEqual(['**/other-team/CLAUDE.md']);
    expect(settings.permissions.deny).toEqual(['Read(./.env)']);
    expect(settings.permissions.allow).toEqual(['Bash(npm run lint)']);
    // XForge's governance dispatcher is added ahead of the team's own PreToolUse hook.
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('xforge hook dispatch');
    expect(settings.hooks.PreToolUse[1]).toEqual(USER_SETTINGS.hooks.PreToolUse[0]);
  });

  it('stays idempotent and tolerates later user edits to keys XForge does not own', async () => {
    const root = await fixture();
    await write(root, '.claude/settings.json', `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
    expect((await runCli(root, ['install', '--target', 'claude'])).code).toBe(0);
    const stateBefore = await readFile(path.join(root, 'xforge', '.state.json'), 'utf8');

    const second = await runCli(root, ['install', '--target', 'claude']);
    expect(second.code).toBe(0);
    expect(second.json.changes.filter((item: any) => item.path === '.claude/settings.json')).toEqual([
      expect.objectContaining({ action: 'skip' }),
    ]);
    expect(await readFile(path.join(root, 'xforge', '.state.json'), 'utf8')).toBe(stateBefore);

    const edited = await json(root, '.claude/settings.json');
    edited.model = 'sonnet';
    edited.permissions.deny.push('Read(./secrets/**)');
    await write(root, '.claude/settings.json', `${JSON.stringify(edited, null, 2)}\n`);

    const third = await runCli(root, ['install', '--target', 'claude']);
    expect(third.code, JSON.stringify(third.json.diagnostics, null, 2)).toBe(0);
    expect(third.json.diagnostics.map((item: any) => item.code)).not.toContain('XFORGE_MANAGED_FILE_MODIFIED');
    const settings = await json(root, '.claude/settings.json');
    expect(settings.model).toBe('sonnet');
    expect(settings.permissions.deny).toEqual(['Read(./.env)', 'Read(./secrets/**)']);
    // The record tracks the owned material only, so an unowned edit must not churn it.
    expect(await readFile(path.join(root, 'xforge', '.state.json'), 'utf8')).toBe(stateBefore);
  });

  it('still refuses to proceed when a user rewrites material XForge owns', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'claude'])).code).toBe(0);
    const settings = await json(root, '.claude/settings.json');
    settings.hooks.PreToolUse[0].hooks[0].command = 'rm -rf /';
    await write(root, '.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`);

    const result = await runCli(root, ['install', '--target', 'claude']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_MANAGED_FILE_MODIFIED');
    expect((await json(root, '.claude/settings.json')).hooks.PreToolUse[0].hooks[0].command).toBe('rm -rf /');
  });

  // P0-4: Claude Code loads CLAUDE.md, never AGENTS.md, so the `xforge` invocation
  // contract never reached Claude users.
  it('merges an XForge block into an existing CLAUDE.md, pointing at xforge/XFORGE.md', async () => {
    const root = await fixture();
    await write(root, 'CLAUDE.md', '# Our project\n\nRun `make dev` first.\n');
    expect((await runCli(root, ['install', '--target', 'claude'])).code).toBe(0);

    const memory = await readFile(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(memory).toContain('# Our project');
    expect(memory).toContain('Run `make dev` first.');
    expect(memory).toContain('xforge/XFORGE.md');
    expect(memory).not.toContain('@AGENTS.md');
    expect(memory.indexOf('# Our project')).toBeLessThan(memory.indexOf('xforge/XFORGE.md'));
  });

  it('creates CLAUDE.md from scratch when the repository has none', async () => {
    const root = await fixture();
    expect((await runCli(root, ['install', '--target', 'claude'])).code).toBe(0);
    expect(await readFile(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('xforge/XFORGE.md');
  });
});
