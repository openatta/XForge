import { describe, expect, it } from 'vitest';
import { fixture, runCliWithInput, temporaryDirectory } from '../helpers.js';

/**
 * The Hook CLI contract platforms rely on: stdout is always exactly one JSON line in the
 * platform's output shape, a failed dispatch exits 2 (0 for `after` events), and a failure can
 * never degrade into "no decision" — the output must be fail-closed, never an empty `{}`.
 */
describe('hook dispatch CLI wiring', () => {
  const readPayload = JSON.stringify({
    tool_name: 'Read', tool_input: { file_path: 'README.md' }, agent: 'worker', session_id: 's1', tool_use_id: 't1',
  });

  it('fails closed with exit 2 and a deny decision line when the dispatcher itself fails', async () => {
    const root = await temporaryDirectory(); // no project here: loadProject throws
    const result = await runCliWithInput(root, ['hook', 'dispatch', '--target', 'codex', '--event', 'agent.tool.before'], readPayload);
    expect(result.code).toBe(2);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'XForge governance dispatcher failed closed.',
      },
    });
  });

  it('fails closed with exit 2 on malformed stdin JSON instead of a stack trace', async () => {
    const root = await fixture();
    const result = await runCliWithInput(root, ['hook', 'dispatch', '--target', 'codex', '--event', 'agent.tool.before'], 'not-json{');
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain('SyntaxError');
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });

  it('emits the platform decision as a single stdout JSON line and exits 0 on success', async () => {
    const root = await fixture();
    const payload = JSON.stringify({
      tool_name: 'Write', tool_input: { file_path: 'xforge/constitution.md' }, agent: 'worker', session_id: 's1', tool_use_id: 't1',
    });
    const result = await runCliWithInput(root, ['hook', 'dispatch', '--target', 'codex', '--event', 'agent.tool.before'], payload);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const output = JSON.parse(lines[0]!);
    /* The shipped protected-files policy denies this write. */
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('Shared governance files'),
      },
    });
  });

  it('still emits the fail-closed platform line when --event is missing', async () => {
    const root = await fixture();
    const result = await runCliWithInput(root, ['hook', 'dispatch', '--target', 'codex'], readPayload);
    /* Argument errors must not leak the Envelope onto the platform output channel: a platform
       would read unknown fields as "no decision" and fail open. */
    expect(result.code).toBe(2);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });

  it('returns exit 0 for a failed after event so platform bookkeeping is not broken', async () => {
    const root = await temporaryDirectory();
    const result = await runCliWithInput(root, ['hook', 'dispatch', '--target', 'codex', '--event', 'agent.tool.after'], readPayload);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({});
  });
});
