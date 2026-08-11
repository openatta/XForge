import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeHookDispatch } from '../../src/commands/hook.js';
import { readAuditEvents, verifyAudit } from '../../src/core/audit.js';
import { loadProject } from '../../src/core/project-loader.js';
import { fixture, runCli, updateYaml, write } from '../helpers.js';

async function withScriptHook(root: string, options: {
  hookId: string; scriptId: string; failurePolicy: 'deny' | 'ask' | 'stop' | 'spool' | 'warn'; scriptBody: string;
}): Promise<void> {
  await write(root, `xforge/scripts/${options.scriptId}/script.yaml`, [
    'apiVersion: xforge.dev/v1alpha1', 'kind: Script', 'metadata:', `  name: ${options.scriptId}`, '  version: 1',
    'spec:', '  runtime: node', '  entry: main.mjs', '  arguments: []', '  workingDirectory: .',
    '  timeoutSeconds: 5', '  input: JSON on stdin', '  output: JSON decision line', '  sideEffects: none', '',
  ].join('\n'));
  await write(root, `xforge/scripts/${options.scriptId}/main.mjs`, options.scriptBody);
  await write(root, `xforge/scaffold/hooks/${options.hookId}.yaml`, [
    'apiVersion: xforge.dev/v1alpha2', 'kind: Hook', 'metadata:', `  name: ${options.hookId}`, '  version: 1',
    'spec:', '  enabled: true', '  plane: runtime', '  event: agent.tool.before',
    `  action: { scriptRef: ${options.scriptId} }`, `  failurePolicy: ${options.failurePolicy}`, '  timeoutSeconds: 5', '',
  ].join('\n'));
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
    manifest.scripts.push(options.scriptId);
    manifest.scaffold.hooks.push(options.hookId);
  });
}

describe('runtime governance adapters', () => {
  it('projects platform-native policy bridges for all five targets', async () => {
    const root = await fixture();
    const installed = await runCli(root, ['install']);
    expect(installed.code, JSON.stringify(installed.json.diagnostics, null, 2)).toBe(0);

    const claude = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    expect(claude.permissions.deny).toEqual(expect.arrayContaining(['Edit(xforge/manifest.yaml)', 'Write(xforge/manifest.yaml)']));
    expect(claude.hooks.PreToolUse[0].hooks[0].command).toContain('npx --no-install xforge hook dispatch');

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

  it('runs a custom scriptRef Hook and its deny beats a matching PermissionPolicy allow', async () => {
    const root = await fixture();
    await withScriptHook(root, {
      hookId: 'deny-read-tool', scriptId: 'deny-read-tool-script', failurePolicy: 'deny',
      scriptBody: [
        'let data = "";',
        'process.stdin.on("data", (chunk) => { data += chunk; });',
        'process.stdin.on("end", () => {',
        '  const payload = JSON.parse(data);',
        '  const deny = payload.tool_name === "Read";',
        '  process.stdout.write(JSON.stringify({ decision: deny ? "deny" : "allow", reason: "script-hook-veto" }) + "\\n");',
        '});',
      ].join('\n'),
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const project = await loadProject(root, { exactRoot: true });
    const denied = await executeHookDispatch(project, {
      target: 'codex', event: 'agent.tool.before',
      payload: { tool_name: 'Read', tool_input: { file_path: 'README.md' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(denied.decision).toBe('deny');
    expect(denied.scriptHooks).toEqual([{ hookId: 'deny-read-tool', scriptId: 'deny-read-tool-script', decision: 'deny', failed: false }]);

    const allowed = await executeHookDispatch(project, {
      target: 'codex', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'src/app.ts' }, agent: 'worker', session_id: 's1', tool_use_id: 't2' },
    });
    expect(allowed.decision).toBe('allow');
    expect(allowed.scriptHooks).toEqual([{ hookId: 'deny-read-tool', scriptId: 'deny-read-tool-script', decision: 'allow', failed: false }]);
  });

  it('applies the Hook failurePolicy when a scriptRef script exits non-zero', async () => {
    const root = await fixture();
    await withScriptHook(root, {
      hookId: 'always-broken', scriptId: 'always-broken-script', failurePolicy: 'deny',
      scriptBody: 'process.stderr.write("boom\\n"); process.exit(1);\n',
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'codex', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'src/app.ts' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(result.decision).toBe('deny');
    expect(result.scriptHooks).toEqual([{ hookId: 'always-broken', scriptId: 'always-broken-script', decision: 'deny', failed: true }]);
    const events = await readAuditEvents(project);
    const runtime = events.find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.outcome).toBe('denied');
  });

  it('does not block on a spooled scriptRef Hook failure', async () => {
    const root = await fixture();
    await withScriptHook(root, {
      hookId: 'best-effort', scriptId: 'best-effort-script', failurePolicy: 'spool',
      scriptBody: 'process.stderr.write("unavailable\\n"); process.exit(1);\n',
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'codex', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'src/app.ts' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(result.decision).toBeNull();
    expect(result.scriptHooks).toEqual([{ hookId: 'best-effort', scriptId: 'best-effort-script', decision: null, failed: true }]);
    const events = await readAuditEvents(project);
    const runtime = events.find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.outcome).toBe('spooled');
  });
});
