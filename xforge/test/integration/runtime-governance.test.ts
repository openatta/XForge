import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeHookDispatch } from '../../src/commands/hook.js';
import { readAuditEvents, verifyAudit } from '../../src/core/audit.js';
import { loadProject } from '../../src/core/project-loader.js';
import { fixture, runCli } from '../helpers.js';

describe('runtime governance adapters', () => {
  it('projects platform-native policy bridges for all five targets', async () => {
    const root = await fixture();
    const installed = await runCli(root, ['install']);
    expect(installed.code, JSON.stringify(installed.json.diagnostics, null, 2)).toBe(0);

    const claude = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    expect(claude.permissions.deny).toEqual(expect.arrayContaining(['Edit(xforge/manifest.yaml)', 'Write(xforge/manifest.yaml)']));
    expect(claude.hooks.PreToolUse[0].hooks[0].command).toContain('xforge hook dispatch');

    const codex = JSON.parse(await readFile(path.join(root, '.codex', 'hooks.json'), 'utf8'));
    expect(codex.hooks.PreToolUse[0].hooks[0].statusMessage).toContain('XForge');

    const cursor = JSON.parse(await readFile(path.join(root, '.cursor', 'hooks.json'), 'utf8'));
    expect(cursor).toMatchObject({ version: 1 });
    expect(cursor.hooks.preToolUse[0]).not.toHaveProperty('bash');

    const copilot = JSON.parse(await readFile(path.join(root, '.github', 'hooks', 'xforge.json'), 'utf8'));
    expect(copilot).toMatchObject({ version: 1, disableAllHooks: false });
    expect(copilot.hooks.preToolUse[0].bash).toContain('github-copilot');

    const opencode = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    expect(opencode.permissions).toContainEqual(expect.objectContaining({ action: 'edit', effect: 'deny', resource: 'xforge/manifest.yaml' }));
    expect(await readFile(path.join(root, '.opencode', 'plugins', 'xforge-governance.ts'), 'utf8')).toContain('execute.before');

    expect(claude.hooks).not.toHaveProperty('PostToolUse');
  });

  it('denies a protected write and records only digests in runtime audit', async () => {
    const root = await fixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'codex', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'xforge/manifest.yaml', content: 'secret-body' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(result.decision).toBe('deny');
    expect(result.platformOutput).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    const events = await readAuditEvents(project);
    const runtime = events.find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.refs.policies).toEqual(['protected-files']);
    expect(JSON.stringify(runtime)).not.toContain('secret-body');
    expect((await verifyAudit(project)).valid).toBe(true);
  });
});
