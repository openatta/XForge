import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvedResourceEntries } from '../../src/core/lockfile.js';
import { loadProject } from '../../src/core/project-loader.js';
import { loadSelectedResources } from '../../src/core/resource-loader.js';
import { fixture, runCliWithStdin, updateYaml, write } from '../helpers.js';

/**
 * `runCli` (see helpers.ts) spawns the real CLI binary but pipes stdin from `/dev/null`
 * (`stdio: ['ignore', ...]`), so it can never exercise `hook`'s `for await (const chunk of
 * process.stdin)` parsing (`src/cli.ts` ~427-429) or its event-dependent exit code (~461-468).
 * Every existing Hook test drives `executeHookDispatch`/`hookFailureOutput` as plain functions,
 * which bypasses stdin and the process exit code entirely. These tests go through the real
 * spawned process, using `runCliWithStdin`, to cover that boundary.
 */

async function withAllowShellPolicy(root: string): Promise<void> {
  await write(root, 'xforge/scaffold/policies/allow-echo.yaml', [
    'apiVersion: xforge.dev/v1alpha2', 'kind: PermissionPolicy', 'metadata:', '  name: allow-echo', '  version: 1',
    'spec:', '  capability: shell', '  effect: allow', '  match:', '    commands: ["echo *"]',
    '  reason: Explicitly allowed for the CLI-boundary hook test.', '',
  ].join('\n'));
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
    (manifest.scaffold.policies ??= []).push('allow-echo');
  });
  await relock(root);
}

/** The dispatcher refuses to enforce a policy set that does not match `xforge/lock.yaml`, so a test
 *  that adds a policy has to re-seal it exactly as `xforge install` would. Only `resources` is
 *  rewritten; regenerating the whole lock would also rewrite the CLI identity block. */
async function relock(root: string): Promise<void> {
  const project = await loadProject(root, { exactRoot: true });
  const entries = await resolvedResourceEntries(project, await loadSelectedResources(project));
  await updateYaml(root, 'xforge/lock.yaml', (lock) => { lock.resources = entries; });
}

/** A fixture whose lock is sealed over its own resources, i.e. the state every installed project is
 *  in. The two fail-closed tests below start from here and mutate a policy afterwards. */
async function sealedFixture(): Promise<string> {
  const root = await fixture();
  await relock(root);
  return root;
}

describe('hook CLI boundary (stdin parsing and exit codes)', () => {
  it('parses well-formed stdin JSON for a before/permission event and exits 0 with the platform decision', async () => {
    const root = await sealedFixture();
    await withAllowShellPolicy(root);
    const payload = JSON.stringify({
      tool_name: 'Bash', tool_input: { command: 'echo hi' }, agent: 'worker', session_id: 's1', tool_use_id: 't1',
    });
    const result = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'claude', '--event', 'agent.tool.before'], payload);
    expect(result.code).toBe(0);
    expect(result.json).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Explicitly allowed for the CLI-boundary hook test.',
      },
    });
  });

  it('fails closed with exit code 2 on malformed stdin JSON for a blocking (before) event', async () => {
    const root = await sealedFixture();
    const result = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'claude', '--event', 'agent.tool.before'], '{not valid json');
    expect(result.code).toBe(2);
    // The generic fail-closed deny from hookFailureOutput('claude', 'agent.tool.before'), not a
    // crash or a stack-trace leak onto stdout.
    expect(result.json).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'XForge governance dispatcher failed closed.',
      },
    });
    expect(result.stdout).not.toContain('SyntaxError');
    expect(result.stdout).not.toContain('at JSON.parse');
  });

  it('exits 0 even on a dispatch failure for an after-suffixed event (after-events never block)', async () => {
    const root = await sealedFixture();
    // A genuine internal failure (e.g. a script Hook throwing) on a real `*.after` event would need
    // a scriptRef Hook fixture wired through `install` to trigger deterministically; malformed JSON
    // is a lighter-weight way to force `result.ok === false` and confirm the routing this test cares
    // about: cli.ts's `parsed.event?.includes('after')` branch, which is what keeps after-events from
    // ever blocking regardless of why the dispatch failed.
    const result = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'claude', '--event', 'agent.tool.after'], '{not valid json');
    expect(result.code).toBe(0);
    // hookFailureOutput returns {} for a non-before/non-permission event: nothing to enforce on an
    // event that cannot block.
    expect(result.json).toEqual({});
  });

  it('still exits 2 on malformed JSON for the agent.permission.request event, which also blocks', async () => {
    const root = await sealedFixture();
    const result = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'codex', '--event', 'agent.permission.request'], '{not valid json');
    expect(result.code).toBe(2);
    expect(result.json).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'XForge governance dispatcher failed closed.' } },
    });
  });

  it('fails closed with a platform deny line, not an Envelope, when argument parsing itself throws', async () => {
    const root = await sealedFixture();
    // `--bogus` throws XFORGE_OPTION_UNKNOWN inside parseArguments, so `parsed` is null and the
    // normal error path would emit a full Envelope — which a host reads as a decision object with
    // no opinion, i.e. every tool call silently permitted. cli.ts recovers the command position and
    // the raw --target/--event instead.
    const result = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'cursor', '--event', 'agent.tool.before', '--bogus'], '{}');
    expect(result.code).toBe(2);
    // Cursor's own shape, recovered from raw argv: a codex/claude-shaped payload would be
    // unrecognisable to this host and would fail open by another route.
    expect(result.json).toEqual({
      permission: 'deny',
      user_message: 'XForge governance dispatcher failed closed.',
      agent_message: 'XForge governance dispatcher failed closed.',
    });
    expect(result.json.ok).toBeUndefined();
    expect(result.stdout).not.toContain('diagnostics');
  });

  it('still returns a diagnostic Envelope for a non-hook command that merely carries "hook" as an option value', async () => {
    const root = await sealedFixture();
    // `argv.includes('hook')` would misroute this onto the Hook output channel. The command position
    // is `state`; `hook` is only the value of --change.
    const result = await runCliWithStdin(root, ['state', '--change', 'hook', '--bogus'], '');
    expect(result.code).toBe(1);
    expect(result.json?.ok).toBe(false);
    expect(result.json?.diagnostics?.[0]?.code).toBe('XFORGE_OPTION_UNKNOWN');
  });

  it('treats empty stdin as an empty payload object rather than a parse failure', async () => {
    const root = await sealedFixture();
    // `source ? JSON.parse(source) : {}` in cli.ts short-circuits on an empty (post-trim) stdin, so
    // this must not exit 2. It is not, however, a test of an indefinitely-hanging/never-closed
    // stdin stream (that would risk hanging the suite); `runCliWithStdin` always `.end()`s stdin
    // immediately, so a genuinely-hanging-stdin path remains an untested gap here.
    const result = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'claude', '--event', 'agent.tool.before'], '');
    expect(result.code).toBe(0);
    // No tool_name in the payload -> classified 'unknown' -> default unknownToolPolicy ('ask') on a
    // target with `ask` support.
    expect(result.json).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } });
  });

  it('emits a platform deny, not an empty no-opinion object, when the policy file has been deleted', async () => {
    const root = await sealedFixture();
    await rm(path.join(root, 'xforge', 'scaffold', 'policies', 'protected-files.yaml'));
    // End-to-end confirmation that the dispatcher's new refusal reaches the host correctly: an
    // XForgeError thrown inside `executeHookDispatch` has to arrive as the fail-closed deny line and
    // exit 2, not as an Envelope (which a host reads as "no opinion", i.e. every call permitted).
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'xforge/manifest.yaml' }, session_id: 's1', tool_use_id: 't1' });
    const result = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'claude', '--event', 'agent.tool.before'], payload);
    expect(result.code).toBe(2);
    expect(result.json).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'XForge governance dispatcher failed closed.',
      },
    });
  });

  it('emits a platform deny when a policy file no longer matches xforge/lock.yaml', async () => {
    const root = await sealedFixture();
    const policy = path.join('xforge', 'scaffold', 'policies', 'protected-files.yaml');
    await updateYaml(root, policy.split(path.sep).join('/'), (value) => { value.spec.effect = 'allow'; });
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'xforge/manifest.yaml' }, session_id: 's1', tool_use_id: 't1' });
    const result = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'claude', '--event', 'agent.tool.before'], payload);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});
