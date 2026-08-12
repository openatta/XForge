import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeHookDispatch, hookFailureOutput } from '../../src/commands/hook.js';
import { readAuditEvents, verifyAudit } from '../../src/core/audit.js';
import { loadProject } from '../../src/core/project-loader.js';
import { fixture, runCli, updateYaml, write } from '../helpers.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

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

async function withPolicy(root: string, id: string, specLines: string[]): Promise<void> {
  await write(root, `xforge/scaffold/policies/${id}.yaml`, [
    'apiVersion: xforge.dev/v1alpha2', 'kind: PermissionPolicy', 'metadata:', `  name: ${id}`, '  version: 1',
    'spec:', ...specLines, '',
  ].join('\n'));
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
    (manifest.scaffold.policies ??= []).push(id);
  });
}

describe('runtime governance adapters', () => {
  it('projects platform-native policy bridges for all five targets', async () => {
    const root = await fixture();
    const installed = await runCli(root, ['install']);
    expect(installed.code, JSON.stringify(installed.json.diagnostics, null, 2)).toBe(0);

    const claude = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    // The shipped `protected-files` policy carries `exceptActors: [integrator]`, which Claude's
    // static `permissions.deny` cannot express — and that layer is a hard platform refusal
    // evaluated before the PreToolUse hook, so flattening it would lock the Integrator out of the
    // writes `xforge-apply` requires. It is therefore bridge-only, and the gap is reported.
    expect(claude.permissions).toBeUndefined();
    expect(claude.hooks.PreToolUse[0].hooks[0].command).toContain('npx --no-install xforge hook dispatch');
    expect(installed.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_POLICY_STATIC_LAYER_DEGRADED');

    const codex = JSON.parse(await readFile(path.join(root, '.codex', 'hooks.json'), 'utf8'));
    expect(codex.hooks.PreToolUse[0].hooks[0].statusMessage).toContain('XForge');

    const cursor = JSON.parse(await readFile(path.join(root, '.cursor', 'hooks.json'), 'utf8'));
    expect(cursor).toMatchObject({ version: 1 });
    expect(cursor.hooks.preToolUse[0]).not.toHaveProperty('bash');

    const copilot = JSON.parse(await readFile(path.join(root, '.github', 'hooks', 'xforge.json'), 'utf8'));
    expect(copilot).toMatchObject({ version: 1, disableAllHooks: false });
    expect(copilot.hooks.preToolUse[0].bash).toContain('github-copilot');

    // Same reason as Claude: with only `protected-files` selected there is nothing the OpenCode
    // static layer may carry, so no `opencode.json` is written at all.
    expect(await exists(path.join(root, 'opencode.json'))).toBe(false);
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

  it('still denies a protected write under the shipped protected-files policy globs', async () => {
    const root = await fixture();
    const project = await loadProject(root, { exactRoot: true });
    const denied = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'xforge/specs/foo.md' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(denied.decision).toBe('deny');
    expect(denied.policyRefs).toEqual(['protected-files']);

    const nested = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Edit', tool_input: { file_path: 'xforge/specs/auth/spec.md' }, agent: 'worker', session_id: 's1', tool_use_id: 't2' },
    });
    expect(nested.decision).toBe('deny');

    const constitution = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'xforge/constitution.md' }, agent: 'worker', session_id: 's1', tool_use_id: 't3' },
    });
    expect(constitution.decision).toBe('deny');
  });

  it('does not let a `*` wildcard cross a path separator (src/** must not match srcfoo/x)', async () => {
    const root = await fixture();
    await withPolicy(root, 'guard-src', [
      '  capability: fs.write', '  effect: deny', '  match:', '    paths:', '      - src/**',
      '  reason: src is guarded.',
    ]);
    const project = await loadProject(root, { exactRoot: true });

    const inside = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'src/a/b.ts' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(inside.decision).toBe('deny');
    expect(inside.policyRefs).toEqual(['guard-src']);

    const sibling = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'srcfoo/x' }, agent: 'worker', session_id: 's1', tool_use_id: 't2' },
    });
    expect(sibling.decision).toBeNull();
    expect(sibling.policyRefs).toEqual([]);
  });

  it('classifies an MCP tool as mcp even when its name contains read/write', async () => {
    const root = await fixture();
    await withPolicy(root, 'guard-mcp-filesystem', [
      '  capability: mcp', '  effect: deny', '  match:', '    mcpServers:', '      - filesystem',
      '  reason: The filesystem MCP server is not approved.',
    ]);
    await withPolicy(root, 'ask-on-reads', [
      '  capability: fs.read', '  effect: ask', '  match:', '    paths:', '      - "**"',
      '  reason: Reads are reviewed.',
    ]);
    const project = await loadProject(root, { exactRoot: true });

    const result = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'mcp__filesystem__read_file', tool_input: { path: 'README.md' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    // The old regex cascade hit /read/ first and classified this as fs.read, so every mcp policy
    // silently failed to apply to it.
    expect(result.policyRefs).toEqual(['guard-mcp-filesystem']);
    expect(result.decision).toBe('deny');

    const events = await readAuditEvents(project);
    const runtime = events.find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.coverage.gaps).toEqual([]);
  });

  it('asks and records a coverage gap for a tool it cannot classify instead of silently allowing', async () => {
    const root = await fixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Grep', tool_input: { pattern: 'password' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(result.decision).toBe('ask');
    expect(result.policyRefs).toEqual([]);
    const events = await readAuditEvents(project);
    const runtime = events.find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.coverage.gaps).toEqual(['unknown-tool:Grep']);
    expect(runtime?.decision).toBe('ask');
    expect((await verifyAudit(project)).valid).toBe(true);
  });

  it('does not turn an unclassifiable tool into a Codex deny, but still denies a policy ask there', async () => {
    const root = await fixture();
    const project = await loadProject(root, { exactRoot: true });

    /* Codex has no `ask`. Resolving the unknown-tool default to `deny` would block Grep/Glob on
       every Codex call as soon as any policy exists — which the shipped scaffold always does. */
    const unclassified = await executeHookDispatch(project, {
      target: 'codex', event: 'agent.tool.before',
      payload: { tool_name: 'Grep', tool_input: { pattern: 'x' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(unclassified.decision).toBe('ask');
    expect(unclassified.platformOutput).toEqual({});
    const gaps = (await readAuditEvents(project)).find((event) => event.eventType === 'agent.tool.before')?.coverage.gaps;
    expect(gaps).toEqual(['unknown-tool:Grep']);

    /* A deliberate `ask` written by a human still degrades conservatively to deny. */
    await write(root, 'xforge/scaffold/policies/ask-shell.yaml', [
      'apiVersion: xforge.dev/v1alpha2', 'kind: PermissionPolicy',
      'metadata:', '  name: ask-shell', '  version: 1',
      'spec:', '  capability: shell', '  effect: ask',
      '  match:', '    commands: ["git push*"]',
      '  reason: Pushing needs a human decision.', '',
    ].join('\n'));
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.scaffold.policies = [...(manifest.scaffold.policies ?? []), 'ask-shell'];
    });
    const asked = await executeHookDispatch(await loadProject(root, { exactRoot: true }), {
      target: 'codex', event: 'agent.tool.before',
      payload: { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, agent: 'worker', session_id: 's1', tool_use_id: 't2' },
    });
    expect(asked.decision).toBe('ask');
    expect(asked.platformOutput).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('honours manifest.runtime.unknownToolPolicy for unclassifiable tools', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.runtime = { unknownToolPolicy: 'deny' };
    });
    const project = await loadProject(root, { exactRoot: true });
    const denied = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Grep', tool_input: { pattern: 'x' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(denied.decision).toBe('deny');

    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.runtime = { unknownToolPolicy: 'allow' };
    });
    const deferring = await loadProject(root, { exactRoot: true });
    const allowed = await executeHookDispatch(deferring, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Grep', tool_input: { pattern: 'x' }, agent: 'worker', session_id: 's1', tool_use_id: 't2' },
    });
    expect(allowed.decision).toBeNull();
    const events = await readAuditEvents(deferring);
    expect(events.filter((event) => event.eventType === 'agent.tool.before').every((event) => event.coverage.gaps.includes('unknown-tool:Grep'))).toBe(true);
  });

  it('still evaluates fs.write policies against an unrecognised write-shaped tool', async () => {
    const root = await fixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'SuperPatcher', tool_input: { file_path: 'xforge/manifest.yaml' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(result.decision).toBe('deny');
    expect(result.policyRefs).toEqual(['protected-files']);
    const events = await readAuditEvents(project);
    const runtime = events.find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.coverage.gaps).toEqual(['unknown-tool:SuperPatcher']);
  });

  it('treats plan bookkeeping tools as outside the capability model', async () => {
    const root = await fixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'TodoWrite', tool_input: { todos: [] }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(result.decision).toBeNull();
    const events = await readAuditEvents(project);
    const runtime = events.find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.coverage.gaps).toEqual([]);
  });

  it('fails closed when the dispatcher itself fails', () => {
    expect(hookFailureOutput('claude', 'agent.tool.before')).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
    expect(hookFailureOutput('codex', 'agent.permission.request')).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
    expect(hookFailureOutput('cursor', 'agent.tool.before')).toMatchObject({ permission: 'deny' });
    expect(hookFailureOutput('github-copilot', 'agent.tool.before')).toMatchObject({ permissionDecision: 'deny' });
    expect(hookFailureOutput('opencode', 'agent.tool.before')).toMatchObject({ decision: 'deny' });
    expect(hookFailureOutput('claude', 'agent.tool.after')).toEqual({});
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
