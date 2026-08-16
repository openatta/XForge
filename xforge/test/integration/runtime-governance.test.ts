import { access, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeHookDispatch, hookFailureOutput } from '../../src/commands/hook.js';
import { readAuditEvents, verifyAudit } from '../../src/core/audit.js';
import { matchWildcard } from '../../src/core/governance.js';
import { resolvedResourceEntries } from '../../src/core/lockfile.js';
import { loadProject } from '../../src/core/project-loader.js';
import { loadSelectedResources } from '../../src/core/resource-loader.js';
import { fixture, runCli, updateYaml, write } from '../helpers.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

/**
 * The dispatcher now refuses to enforce a PermissionPolicy/Hook set that does not match
 * `xforge/lock.yaml` (see "a tampered policy file denies rather than evaporates" below), so any test
 * that legitimately adds or edits a policy has to re-seal the lock exactly as `xforge install`
 * would. Only the `resources` list is rewritten: regenerating the whole lock would also rewrite the
 * CLI identity block, which is not what these tests are varying.
 */
async function relock(root: string): Promise<void> {
  const project = await loadProject(root, { exactRoot: true });
  const entries = await resolvedResourceEntries(project, await loadSelectedResources(project));
  await updateYaml(root, 'xforge/lock.yaml', (lock) => { lock.resources = entries; });
}

/** A fixture whose lock is sealed over its own resources, i.e. the state every installed project is
 *  in. Tests that want to observe the *unsealed* refusal start from here and mutate afterwards. */
async function sealedFixture(): Promise<string> {
  const root = await fixture();
  await relock(root);
  return root;
}

function writePayload(toolInput: unknown, extra: Record<string, unknown> = {}): Record<string, any> {
  return { tool_name: 'Write', tool_input: toolInput, agent: 'worker', session_id: 's1', tool_use_id: 't1', ...extra };
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
  await relock(root);
}

describe('runtime governance adapters', () => {
  it('projects platform-native policy bridges for all five targets', async () => {
    const root = await sealedFixture();
    const installed = await runCli(root, ['install']);
    expect(installed.code, JSON.stringify(installed.json.diagnostics, null, 2)).toBe(0);

    const claude = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    // The shipped `protected-files` policy carries `exceptActors: [integrator]`, which Claude's
    // static `permissions.deny` cannot express — and that layer is a hard platform refusal
    // evaluated before the PreToolUse hook, so flattening it would lock the Integrator out of the
    // writes `xforge-apply` requires. It is therefore bridge-only, and the gap is reported.
    expect(claude.permissions).toBeUndefined();
    expect(claude.hooks.PreToolUse[0].hooks[0].command).toContain('xforge hook dispatch');
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
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'codex', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'xforge/constitution.md', content: 'secret-body' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
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
    const root = await sealedFixture();
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
    const root = await sealedFixture();
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
    const root = await sealedFixture();
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
    const root = await sealedFixture();
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
    const root = await sealedFixture();
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
    await relock(root);
    const asked = await executeHookDispatch(await loadProject(root, { exactRoot: true }), {
      target: 'codex', event: 'agent.tool.before',
      payload: { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, agent: 'worker', session_id: 's1', tool_use_id: 't2' },
    });
    expect(asked.decision).toBe('ask');
    expect(asked.platformOutput).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('honours manifest.runtime.unknownToolPolicy for unclassifiable tools', async () => {
    const root = await sealedFixture();
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
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'SuperPatcher', tool_input: { file_path: 'xforge/constitution.md' }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    expect(result.decision).toBe('deny');
    expect(result.policyRefs).toEqual(['protected-files']);
    const events = await readAuditEvents(project);
    const runtime = events.find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.coverage.gaps).toEqual(['unknown-tool:SuperPatcher']);
  });

  it('treats plan bookkeeping tools as outside the capability model', async () => {
    const root = await sealedFixture();
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
    const root = await sealedFixture();
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
    const root = await sealedFixture();
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
    const root = await sealedFixture();
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

describe('fs path syntax cannot be used to slip past a PermissionPolicy', () => {
  /**
   * Every spelling below names the *same file* to a host's Write/Edit tool. Before `resourcesFor`
   * resolved paths, it stripped one leading `./` and did a `startsWith(root + '/')` test, so `.`
   * segments, `//` and `..` all reached the glob matcher intact and only the first entry here was
   * denied. A one-character edit to a path defeated the only policy the product ships.
   */
  const sameFileAsConstitution = [
    'xforge/constitution.md',
    'xforge/./constitution.md',
    'xforge//constitution.md',
    './/xforge/constitution.md',
    './xforge/./constitution.md',
    'xforge/../xforge/constitution.md',
    'xforge/specs/../constitution.md',
  ];

  it('denies every relative spelling of a protected path', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    for (const [index, candidate] of sameFileAsConstitution.entries()) {
      const result = await executeHookDispatch(project, {
        target: 'claude', event: 'agent.tool.before',
        payload: writePayload({ file_path: candidate }, { tool_use_id: `t${index}` }),
      });
      expect(result.decision, candidate).toBe('deny');
      expect(result.policyRefs, candidate).toEqual(['protected-files']);
    }
  });

  it('denies a nested protected path written with an interior . segment', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    for (const candidate of ['xforge/specs/./a.md', 'xforge/specs//auth/./spec.md', 'xforge/./specs/../specs/a.md']) {
      const result = await executeHookDispatch(project, {
        target: 'claude', event: 'agent.tool.before',
        payload: writePayload({ file_path: candidate }),
      });
      expect(result.decision, candidate).toBe('deny');
    }
  });

  it('denies the absolute form of a protected path, including one that detours through ..', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    for (const candidate of [
      path.join(root, 'xforge', 'constitution.md'),
      path.join(root, 'xforge', 'specs', '..', 'constitution.md'),
      `${root}/./xforge//constitution.md`,
    ]) {
      const result = await executeHookDispatch(project, {
        target: 'claude', event: 'agent.tool.before',
        payload: writePayload({ file_path: candidate }),
      });
      expect(result.decision, candidate).toBe('deny');
      expect(result.policyRefs, candidate).toEqual(['protected-files']);
    }
  });

  it('follows the filesystem, not the OS family, when deciding whether case matters', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    /* `NOCASE` used to be `platform === 'win32'`, so on a default (case-insensitive) macOS volume
       `XForge/Manifest.yaml` — literally the same file — matched nothing. The expectation is read
       off the real filesystem so this stays honest on a case-sensitive volume too. */
    const caseInsensitive = existsSync(path.join(root, 'XForge'));
    const result = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: writePayload({ file_path: 'XForge/Constitution.md' }),
    });
    expect(result.decision).toBe(caseInsensitive ? 'deny' : null);
  });

  it('still leaves genuinely unprotected paths without an opinion', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    for (const candidate of ['src/app.ts', './src/./app.ts', 'xforge/scaffold/policies/protected-files.yaml', 'xforge/changes/x/change.yaml']) {
      const result = await executeHookDispatch(project, {
        target: 'claude', event: 'agent.tool.before',
        payload: writePayload({ file_path: candidate }),
      });
      expect(result.decision, candidate).toBeNull();
      expect(result.policyRefs, candidate).toEqual([]);
    }
  });

  it('does not silently permit a write that escapes the project root', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: writePayload({ file_path: '../outside-the-repo.txt' }),
    });
    // Repo-relative `match.paths` cannot describe this path at all, so it is unclassified rather
    // than unmatched — the unknownToolPolicy default (`ask`), not the old silent no-opinion.
    expect(result.decision).toBe('ask');
    const runtime = (await readAuditEvents(project)).find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.coverage.gaps).toContain('resource-outside-root:fs.write');
  });
});

describe('a capability call whose resource cannot be extracted is not silently allowed', () => {
  it('polices Codex apply_patch, whose paths live in the patch body rather than a path field', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'codex', event: 'agent.tool.before',
      payload: {
        tool_name: 'apply_patch',
        tool_input: { input: ['*** Begin Patch', '*** Update File: xforge/constitution.md', '-a', '+b', '*** End Patch'].join('\n') },
        agent: 'worker', session_id: 's1', tool_use_id: 't1',
      },
    });
    // Codex's primary write tool: `input`, not `file_path`, and the old `patchPaths` fallback only
    // fired for a field literally named `command`, so this was unpoliced end to end.
    expect(result.decision).toBe('deny');
    expect(result.policyRefs).toEqual(['protected-files']);
  });

  it('polices NotebookEdit, rename/move and bare-string write payloads', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    const cases: Array<[string, unknown]> = [
      ['NotebookEdit', { notebook_path: 'xforge/specs/analysis.ipynb', new_source: 'print(1)' }],
      ['Move', { source: 'draft.md', destination: 'xforge/specs/final.md' }],
      ['Write', 'xforge/constitution.md'],
    ];
    for (const [toolName, toolInput] of cases) {
      const result = await executeHookDispatch(project, {
        target: 'claude', event: 'agent.tool.before',
        payload: { tool_name: toolName, tool_input: toolInput, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
      });
      expect(result.decision, toolName).toBe('deny');
      expect(result.policyRefs, toolName).toEqual(['protected-files']);
    }
  });

  it('asks rather than deferring when an fs.write call carries no readable path at all', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: writePayload({ content: 'body only, no path' }),
    });
    expect(result.decision).toBe('ask');
    expect(result.platformOutput).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
    const runtime = (await readAuditEvents(project)).find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.coverage.gaps).toContain('resource-unavailable:fs.write');
  });

  it('does not mistake a patch body handed to a path field for a path', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      // A multi-line body in `value` must not count as "a resource was extracted" — that would
      // reinstate the silent pass this suite exists to prevent.
      payload: writePayload('line one\nline two\n'),
    });
    expect(result.decision).toBe('ask');
  });

  it('degrades the unresolved-resource ask to no opinion on Codex, which has no ask', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    const result = await executeHookDispatch(project, {
      target: 'codex', event: 'agent.tool.before',
      payload: writePayload({ content: 'body only, no path' }),
    });
    // Same reasoning as the unknown-tool ask: "XForge could not classify this" is not a human
    // decision, so it must not become a Codex deny.
    expect(result.decision).toBe('ask');
    expect(result.platformOutput).toEqual({});
  });
});

describe('the dispatcher refuses to enforce a broken or unsealed resource set', () => {
  it('fails closed when a selected PermissionPolicy file has been deleted', async () => {
    const root = await sealedFixture();
    await rm(path.join(root, 'xforge', 'scaffold', 'policies', 'protected-files.yaml'));
    const project = await loadProject(root, { exactRoot: true });
    // `xforge/scaffold/**` is deliberately outside the deny list, so deleting the policy is a write
    // the policy itself permits. Previously the missing file was only a diagnostic the dispatcher
    // never read, and every later write returned "no opinion".
    await expect(executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: writePayload({ file_path: 'xforge/constitution.md' }),
    })).rejects.toThrow(/missing/i);
  });

  it('fails closed when a policy is replaced with schema-valid YAML that flips deny to allow', async () => {
    const root = await sealedFixture();
    const original = await readFile(path.join(root, 'xforge', 'scaffold', 'policies', 'protected-files.yaml'), 'utf8');
    await write(root, 'xforge/scaffold/policies/protected-files.yaml', original.replace('effect: deny', 'effect: allow'));
    const project = await loadProject(root, { exactRoot: true });
    /* The dangerous case is *valid* YAML: invalid YAML already made `loadYaml` throw and the
       dispatcher fail closed. Nothing compared the file against xforge/lock.yaml, so a neutered
       policy was accepted at face value and the whole fs.write deny surface evaporated. */
    await expect(executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: writePayload({ file_path: 'xforge/constitution.md' }),
    })).rejects.toThrow(/lock\.yaml/);
  });

  it('fails closed when a selected policy is dropped from the Manifest without reinstalling', async () => {
    const root = await sealedFixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.policies = []; });
    const project = await loadProject(root, { exactRoot: true });
    await expect(executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: writePayload({ file_path: 'xforge/constitution.md' }),
    })).rejects.toThrow(/lock\.yaml/);
  });

  it('accepts a deliberately weakened policy once it has been re-sealed into the lock', async () => {
    const root = await sealedFixture();
    const original = await readFile(path.join(root, 'xforge', 'scaffold', 'policies', 'protected-files.yaml'), 'utf8');
    await write(root, 'xforge/scaffold/policies/protected-files.yaml', original.replace('effect: deny', 'effect: allow'));
    await relock(root);
    // Proves the refusal above is the lock comparison doing the work, not an unrelated failure:
    // an operator who really means it re-seals and the dispatcher enforces the new intent.
    const result = await executeHookDispatch(await loadProject(root, { exactRoot: true }), {
      target: 'claude', event: 'agent.tool.before',
      payload: writePayload({ file_path: 'xforge/constitution.md' }),
    });
    expect(result.decision).toBe('allow');
  });
});

describe('wildcard matching cannot be made to hang the dispatcher', () => {
  it('completes a pathological pattern/subject pair in linear time', () => {
    /* The old implementation compiled `*` to `.*` and let RegExp backtrack, so cost was O(n^k) in
       the number of wildcards — and `n` is the agent's own command string, which it chooses.
       Measured on Node 26 against the previous implementation, with subjects that partially match
       (the shape that actually triggers the blow-up): 3417 ms for the second case, 1220 ms for the
       third, and the first scaling quartically (2443 ms at 400 characters, ~25 minutes
       extrapolated to the 2000 here). All three are now sub-millisecond; the bound below is loose
       only so a loaded CI box cannot flake it. */
    const started = Date.now();
    expect(matchWildcard('*a*a*a*b', 'a'.repeat(2000))).toBe(false);
    expect(matchWildcard('*rm*-rf*/*/*prod', 'rm -rf /tmp/x '.repeat(64))).toBe(false);
    expect(matchWildcard('*curl*|*sh*|*bash', 'curl x | sh | ba '.repeat(66))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('keeps the loose wildcard semantics the non-path capabilities rely on', () => {
    expect(matchWildcard('rm -rf *', 'rm -rf /tmp/x')).toBe(true);
    expect(matchWildcard('*.example.com', 'api.example.com')).toBe(true);
    expect(matchWildcard('mcp__github__*', 'mcp__github__create_issue')).toBe(true);
    expect(matchWildcard('*a*a*a*b', `${'a'.repeat(2000)}b`)).toBe(true);
    expect(matchWildcard('git push*', 'git push origin main')).toBe(true);
    expect(matchWildcard('a?c', 'abc')).toBe(true);
    expect(matchWildcard('a?c', 'ac')).toBe(false);
    expect(matchWildcard('', '')).toBe(true);
    expect(matchWildcard('*', '')).toBe(true);
    // Regex metacharacters in a policy pattern are literal, not silently significant.
    expect(matchWildcard('a+b', 'a+b')).toBe(true);
    expect(matchWildcard('a+b', 'aab')).toBe(false);
    expect(matchWildcard('(x)', '(x)')).toBe(true);
  });

  it('answers a shell PermissionPolicy on a long command without stalling the hook', async () => {
    const root = await sealedFixture();
    await withPolicy(root, 'guard-nested-rm', [
      '  capability: shell', '  effect: deny', '  match:', '    commands:',
      '      - "*a*a*a*b"', '      - "*rm*-rf*prod*"',
      '  reason: Nested destructive commands are denied.',
    ]);
    const project = await loadProject(root, { exactRoot: true });
    const started = Date.now();
    const result = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Bash', tool_input: { command: 'a'.repeat(2000) }, agent: 'worker', session_id: 's1', tool_use_id: 't1' },
    });
    // A hung hook is a fail-open on any host that does not block on timeout, so wall clock is the
    // property under test here, not just the verdict.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.decision).toBeNull();
  });
});

describe('exceptActors reaches the runtime layer', () => {
  it('exempts the Integrator from protected-files when the host names it', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    /* `agent_type` is the field the hosts actually send — the audit `role` below already read it —
       while `actor`/`agent`/`agent_id` are sent by nobody, so the actor was always the literal
       string `'agent'` and `exceptActors: [integrator]` could never match. */
    const exempt = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'xforge/constitution.md' }, agent_type: 'integrator', session_id: 's1', tool_use_id: 't1' },
    });
    expect(exempt.decision).toBeNull();
    expect(exempt.policyRefs).toEqual([]);

    const notExempt = await executeHookDispatch(project, {
      target: 'claude', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'xforge/constitution.md' }, agent_type: 'worker', session_id: 's1', tool_use_id: 't2' },
    });
    expect(notExempt.decision).toBe('deny');
    expect(notExempt.policyRefs).toEqual(['protected-files']);
  });

  it('also accepts subagent_type, and records the resolved actor in the audit chain', async () => {
    const root = await sealedFixture();
    const project = await loadProject(root, { exactRoot: true });
    const exempt = await executeHookDispatch(project, {
      target: 'cursor', event: 'agent.tool.before',
      payload: { tool_name: 'Write', tool_input: { file_path: 'xforge/constitution.md' }, subagent_type: 'integrator', session_id: 's1', tool_use_id: 't1' },
    });
    expect(exempt.decision).toBeNull();
    const runtime = (await readAuditEvents(project)).find((event) => event.eventType === 'agent.tool.before');
    expect(runtime?.actor.id).toBe('integrator');
    expect((await verifyAudit(project)).valid).toBe(true);
  });
});
