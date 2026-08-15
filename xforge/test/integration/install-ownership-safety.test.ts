import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, updateYaml, write } from '../helpers.js';
import type { TargetId } from '../../src/constants.js';
import type { Diagnostic, FileChange } from '../../src/types.js';
import { loadProject } from '../../src/core/project-loader.js';
import { executeProjection } from '../../src/commands/projection.js';
import { executeUninstall } from '../../src/commands/uninstall.js';

/*
 * These exercise the installer through its command entry points in-process rather than through the
 * CLI binary, because every claim here is about what the engine does to files on disk — provenance,
 * refusal, adoption — and none of it about argument parsing. The CLI-level counterparts live in
 * install.test.ts and projection-lifecycle.test.ts.
 */

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function json(root: string, relative: string): Promise<any> {
  return JSON.parse(await readFile(path.join(root, ...relative.split('/')), 'utf8'));
}

interface Outcome {
  diagnostics: Diagnostic[];
  changes: FileChange[];
  codes: string[];
  errors: Diagnostic[];
  action: (relative: string) => string | undefined;
}

function outcome(result: { diagnostics: Diagnostic[]; changes: FileChange[] }): Outcome {
  return {
    ...result,
    codes: result.diagnostics.map((item) => item.code),
    errors: result.diagnostics.filter((item) => item.severity === 'error'),
    action: (relative) => result.changes.find((item) => item.path === relative)?.action,
  };
}

async function install(root: string, options: { target?: TargetId; adopt?: boolean } = {}): Promise<Outcome> {
  const project = await loadProject(root, { exactRoot: true });
  return outcome(await executeProjection(project, 'install', { ...options, dryRun: false }));
}

async function uninstall(root: string, options: { target?: TargetId; force?: boolean } = {}): Promise<Outcome> {
  const project = await loadProject(root, { exactRoot: true });
  return outcome(await executeUninstall(project, { ...options, dryRun: false }));
}

/** One shell policy the static layers can express, so OpenCode gets a real `opencode.json`. */
async function withStaticPolicy(root: string): Promise<void> {
  await write(root, 'xforge/scaffold/policies/no-force-push.yaml', [
    'apiVersion: xforge.dev/v1alpha2', 'kind: PermissionPolicy', 'metadata:', '  name: no-force-push', '  version: 1',
    'spec:', '  capability: shell', '  effect: deny', '  match:', '    commands:', '      - git push --force *',
    '  reason: Force pushes are forbidden.', '',
  ].join('\n'));
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.policies.push('no-force-push'); });
}

const MINIMAL_OPENCODE_CONFIG = { $schema: 'https://opencode.ai/config.json' };

// Finding 1: `removeFragment` inferred "XForge created this file" from the recorded seed, but the
// adapter sets `seed` on every descriptor, so a committed, user-authored config file that happened
// to hold nothing but the seed was deleted by `uninstall` — no conflict, no diagnostic, no backup.
describe('provenance of a partially owned destination', () => {
  it('keeps a user-authored config file that uninstall reduces to nothing but its own minimal contents', async () => {
    const root = await fixture();
    await withStaticPolicy(root);
    // Exactly OpenCode's documented minimal config, as a project would have committed it long
    // before XForge existed — and byte for byte the seed the adapter would have written itself.
    await write(root, 'opencode.json', `${JSON.stringify(MINIMAL_OPENCODE_CONFIG, null, 2)}\n`);
    // An empty placeholder settings file, the same class through the "nothing left" branch.
    await write(root, '.claude/settings.json', '{}\n');
    await write(root, 'CLAUDE.md', '');

    const installed = await install(root);
    expect(installed.errors).toEqual([]);
    expect((await json(root, 'opencode.json')).permission.bash['git push --force *']).toBe('deny');
    expect((await json(root, '.claude/settings.json')).hooks).toBeDefined();

    // Provenance is recorded rather than re-derived, and a destination XForge did not create keeps
    // no seed in the record at all.
    const state = await json(root, 'xforge/.state.json');
    expect(state.targets.opencode.files['opencode.json'].fragment.createdByXForge).toBe(false);
    expect(state.targets.opencode.files['opencode.json'].fragment.seed).toBeUndefined();
    expect(state.targets.claude.files['.claude/settings.json'].fragment.createdByXForge).toBe(false);
    expect(state.targets.claude.files['CLAUDE.md'].fragment.createdByXForge).toBe(false);

    const removed = await uninstall(root);
    expect(removed.errors).toEqual([]);
    expect(await exists(path.join(root, 'opencode.json'))).toBe(true);
    expect(await json(root, 'opencode.json')).toEqual(MINIMAL_OPENCODE_CONFIG);
    expect(await exists(path.join(root, '.claude', 'settings.json'))).toBe(true);
    expect(await json(root, '.claude/settings.json')).toEqual({});
    expect(await exists(path.join(root, 'CLAUDE.md'))).toBe(true);
    expect(await readFile(path.join(root, 'CLAUDE.md'), 'utf8')).not.toContain('@AGENTS.md');
  });

  it('still deletes the same files when XForge created them', async () => {
    const root = await fixture();
    await withStaticPolicy(root);
    expect((await install(root)).errors).toEqual([]);
    expect(await json(root, 'xforge/.state.json'))
      .toMatchObject({ targets: { opencode: { files: { 'opencode.json': { fragment: { createdByXForge: true } } } } } });

    expect((await uninstall(root)).errors).toEqual([]);
    expect(await exists(path.join(root, 'opencode.json'))).toBe(false);
    expect(await exists(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(await exists(path.join(root, '.claude', 'settings.json'))).toBe(false);
  });
});

// Finding 2: the fragment writer replaced any non-object ancestor with `{}` and overwrote the leaf
// unconditionally, and the planner's fragment branch returned before the "not owned by XForge"
// guard every whole-file destination gets — so partially owned destinations had no conflict path.
describe('a value XForge did not write is never overwritten', () => {
  it('refuses to turn OpenCode\'s blanket shell denial into an object of per-command rules', async () => {
    const root = await fixture();
    await withStaticPolicy(root);
    // The documented string shorthand for "block all shell commands".
    const userConfig = { ...MINIMAL_OPENCODE_CONFIG, permission: { bash: 'deny' } };
    await write(root, 'opencode.json', `${JSON.stringify(userConfig, null, 2)}\n`);

    const result = await install(root, { target: 'opencode' });
    expect(result.codes).toContain('XFORGE_INSTALL_CONFLICT');
    expect(result.action('opencode.json')).toBe('conflict');
    expect(result.diagnostics.find((item) => item.code === 'XFORGE_INSTALL_CONFLICT')?.message).toContain('permission.bash');
    // Nothing is applied, so the denial is still in force and the record was never written.
    expect(await json(root, 'opencode.json')).toEqual(userConfig);
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(false);
  });

  it('refuses when the project already owns the exact leaf XForge would write', async () => {
    const root = await fixture();
    await withStaticPolicy(root);
    const userConfig = { ...MINIMAL_OPENCODE_CONFIG, permission: { bash: { 'git push --force *': 'allow' } } };
    await write(root, 'opencode.json', `${JSON.stringify(userConfig, null, 2)}\n`);

    const result = await install(root, { target: 'opencode' });
    expect(result.codes).toContain('XFORGE_INSTALL_CONFLICT');
    expect(await json(root, 'opencode.json')).toEqual(userConfig);
  });

  it('refuses when an owned array address holds something that is not a list', async () => {
    const root = await fixture();
    await write(root, '.claude/settings.json', `${JSON.stringify({ hooks: { PreToolUse: 'off' } }, null, 2)}\n`);

    const result = await install(root, { target: 'claude' });
    expect(result.codes).toContain('XFORGE_INSTALL_CONFLICT');
    expect(await json(root, '.claude/settings.json')).toEqual({ hooks: { PreToolUse: 'off' } });
  });

  it('adopting under --adopt does not license overwriting a value the project owns', async () => {
    const root = await fixture();
    await withStaticPolicy(root);
    const userConfig = { ...MINIMAL_OPENCODE_CONFIG, permission: { bash: 'deny' } };
    await write(root, 'opencode.json', `${JSON.stringify(userConfig, null, 2)}\n`);

    const result = await install(root, { target: 'opencode', adopt: true });
    expect(result.codes).toContain('XFORGE_INSTALL_CONFLICT');
    expect(await json(root, 'opencode.json')).toEqual(userConfig);
  });
});

// Finding 3: digests were compared byte-exactly in both directions, so a Windows clone made with
// git's default `core.autocrlf=true` read as entirely modified — and since every conflict is error
// severity and the whole apply is gated on there being none, install/sync/update wrote nothing and
// `uninstall` refused, leaving the project unable to even remove itself.
describe('line endings are not a user edit', () => {
  const managed = [
    '.agents/skills/xforge-kanban/SKILL.md',
    '.claude/rules/xforge-bootstrap.md',
    'CLAUDE.md',
  ];

  async function toCrlf(root: string, relative: string): Promise<void> {
    const absolute = path.join(root, ...relative.split('/'));
    const content = await readFile(absolute, 'utf8');
    await writeFile(absolute, content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  }

  it('reads a CRLF checkout as current, and still uninstalls it', async () => {
    const root = await fixture();
    expect((await install(root, { target: 'codex' })).errors).toEqual([]);
    expect((await install(root, { target: 'claude' })).errors).toEqual([]);
    for (const relative of managed) await toCrlf(root, relative);

    const again = await install(root, { target: 'claude' });
    expect(again.errors).toEqual([]);
    expect(again.action('.claude/rules/xforge-bootstrap.md')).toBe('skip');
    expect(again.action('CLAUDE.md')).toBe('skip');
    // The working tree is left exactly as the platform wrote it; nothing is rewritten to LF.
    expect(await readFile(path.join(root, '.claude', 'rules', 'xforge-bootstrap.md'), 'utf8')).toContain('\r\n');

    const removed = await uninstall(root);
    expect(removed.errors).toEqual([]);
    expect(await exists(path.join(root, '.claude', 'rules', 'xforge-bootstrap.md'))).toBe(false);
    expect(await exists(path.join(root, '.agents', 'skills', 'xforge-kanban', 'SKILL.md'))).toBe(false);
    expect(await exists(path.join(root, 'CLAUDE.md'))).toBe(false);
  });
});

describe('re-baselining drifted managed files', () => {
  const edited = '.claude/rules/xforge-bootstrap.md';
  const untouched = '.claude/skills/xforge-kanban/SKILL.md';

  it('refuses by default, re-baselines under --adopt, and unblocks every other file with it', async () => {
    const root = await fixture();
    expect((await install(root, { target: 'claude' })).errors).toEqual([]);
    const generated = await readFile(path.join(root, ...edited.split('/')), 'utf8');
    await write(root, edited, 'hand-edited\n');
    // A second file that has something to say, so "one edit blocks everything" is observable.
    await write(root, 'xforge/scaffold/skills/xforge-kanban/SKILL.md', `${await readFile(path.join(root, 'xforge', 'scaffold', 'skills', 'xforge-kanban', 'SKILL.md'), 'utf8')}\n<!-- project customization -->\n`);

    const refused = await install(root, { target: 'claude' });
    expect(refused.codes).toContain('XFORGE_MANAGED_FILE_MODIFIED');
    expect(await readFile(path.join(root, ...edited.split('/')), 'utf8')).toBe('hand-edited\n');
    // The whole apply is gated on there being no errors, so the unrelated file did not move either.
    expect(await readFile(path.join(root, ...untouched.split('/')), 'utf8')).not.toContain('project customization');

    const adopted = await install(root, { target: 'claude', adopt: true });
    expect(adopted.errors).toEqual([]);
    expect(adopted.codes).toContain('XFORGE_MANAGED_FILE_ADOPTED');
    expect(adopted.diagnostics.find((item) => item.code === 'XFORGE_MANAGED_FILE_ADOPTED')?.severity).toBe('info');
    expect(await readFile(path.join(root, ...edited.split('/')), 'utf8')).toBe(generated);
    expect(await readFile(path.join(root, ...untouched.split('/')), 'utf8')).toContain('project customization');

    // The record was repaired, so the next ordinary run is clean.
    const settled = await install(root, { target: 'claude' });
    expect(settled.errors).toEqual([]);
    expect(settled.action(edited)).toBe('skip');
  });

  it('re-baselines XForge-owned keys of a partially managed destination without touching the rest', async () => {
    const root = await fixture();
    await write(root, '.claude/settings.json', `${JSON.stringify({ model: 'opusplan' }, null, 2)}\n`);
    expect((await install(root, { target: 'claude' })).errors).toEqual([]);
    const settings = await json(root, '.claude/settings.json');
    settings.hooks.PreToolUse[0].hooks[0].command = 'rm -rf /';
    await write(root, '.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`);

    expect((await install(root, { target: 'claude' })).codes).toContain('XFORGE_MANAGED_FILE_MODIFIED');
    const adopted = await install(root, { target: 'claude', adopt: true });
    expect(adopted.errors).toEqual([]);
    const repaired = await json(root, '.claude/settings.json');
    expect(repaired.hooks.PreToolUse[0].hooks[0].command).toContain('xforge hook dispatch');
    expect(repaired.model).toBe('opusplan');
  });

  it('uninstall --force removes a managed file that no longer matches its record', async () => {
    const root = await fixture();
    expect((await install(root, { target: 'claude' })).errors).toEqual([]);
    await write(root, edited, 'hand-edited\n');

    const refused = await uninstall(root, { target: 'claude' });
    expect(refused.codes).toContain('XFORGE_UNINSTALL_CONFLICT');
    expect(await exists(path.join(root, ...edited.split('/')))).toBe(true);
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(true);

    const forced = await uninstall(root, { target: 'claude', force: true });
    expect(forced.errors).toEqual([]);
    expect(forced.codes).toContain('XFORGE_UNINSTALL_FORCED');
    expect(await exists(path.join(root, ...edited.split('/')))).toBe(false);
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(false);
  });
});

// Finding 4: the writer emits the generated files before `xforge/.state.json`, so an interrupted
// first install left dozens of correct files and no record. Each one then read as "not
// XForge-managed" at error severity, so nothing could be applied and `uninstall` refused with
// XFORGE_NOT_INSTALLED — an installation that could only be undone by hand.
describe('an interrupted first install', () => {
  it('adopts files whose bytes are already exactly what XForge would write', async () => {
    const root = await fixture();
    expect((await install(root, { target: 'claude' })).errors).toEqual([]);
    const before = await readFile(path.join(root, '.claude', 'skills', 'xforge-kanban', 'SKILL.md'), 'utf8');
    // Everything written, no record: exactly the state a Ctrl-C between the two leaves behind.
    await rm(path.join(root, 'xforge', '.state.json'));

    const resumed = await install(root, { target: 'claude' });
    expect(resumed.errors).toEqual([]);
    expect(resumed.action('.claude/skills/xforge-kanban/SKILL.md')).toBe('skip');
    expect(await readFile(path.join(root, '.claude', 'skills', 'xforge-kanban', 'SKILL.md'), 'utf8')).toBe(before);
    expect(await exists(path.join(root, 'xforge', '.state.json'))).toBe(true);

    // Adopted for real: the installation is removable again.
    const removed = await uninstall(root, { target: 'claude' });
    expect(removed.errors).toEqual([]);
    expect(await exists(path.join(root, '.claude', 'skills', 'xforge-kanban', 'SKILL.md'))).toBe(false);
  });

  it('still refuses a file whose bytes are not XForge\'s output', async () => {
    const root = await fixture();
    await write(root, '.claude/skills/xforge-kanban/SKILL.md', 'human-owned\n');
    const result = await install(root, { target: 'claude' });
    expect(result.codes).toContain('XFORGE_INSTALL_CONFLICT');
    expect(await readFile(path.join(root, '.claude', 'skills', 'xforge-kanban', 'SKILL.md'), 'utf8')).toBe('human-owned\n');
  });
});
