import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { clearVerification, fixture, runCli, runCliWithStdin } from '../helpers.js';

async function manifest(root: string): Promise<string> {
  return readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8');
}

/**
 * The Manifest is the governance dispatcher's input, so a malformed one denies every tool call —
 * including the ones that would repair it. A live run reached exactly that deadlock: an Agent
 * declared the right command but indented it one level short, which swallowed `scaffold.mcpServers`
 * into the new block, and then could not open the file it had just broken.
 *
 * These tests pin both halves of the answer: a command that writes the declaration correctly, and a
 * deny that leaves a way out of itself.
 */
describe('verification declare', () => {
  it('writes a declaration without disturbing anything else in the Manifest', async () => {
    /* No `clearVerification` here: it round-trips the YAML, which strips the very comments this
       test is about. The fixture appends its declaration as text for the same reason. */
    const root = await fixture();
    const before = await manifest(root);
    const comments = before.split('\n').filter((line) => line.trim().startsWith('#')).length;
    expect(comments).toBeGreaterThan(0);

    const result = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests', '--command', '["cargo","test"]', '--by', 'alex']);
    expect(result.code).toBe(0);
    expect(result.json.data.entry.command).toEqual(['cargo', 'test']);
    expect(result.json.data.entry.declaredBy).toBe('alex');
    /* Filled by the CLI, so it cannot be backdated or forgotten. */
    expect(result.json.data.entry.declaredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const after = await manifest(root);
    expect(after.split('\n').filter((line) => line.trim().startsWith('#')).length).toBe(comments);
    expect((await runCli(root, ['check'])).code).toBe(0);
  });

  it('records a dismissal, and refuses one with no stated reason', async () => {
    const root = await fixture();
    const missing = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests', '--not-applicable', 'web/package.json', '--by', 'alex']);
    expect(missing.code).toBe(1);
    expect(missing.json.diagnostics[0].code).toBe('XFORGE_VERIFICATION_ARGUMENTS_REQUIRED');

    const recorded = await runCli(root, [
      'verification', 'declare', '--gate-name', 'unit-tests',
      '--not-applicable', 'web/package.json', '--justification', 'Verified by its own pipeline.', '--by', 'alex',
    ]);
    expect(recorded.code).toBe(0);
    expect(recorded.json.data.entry.notApplicable).toBe('web/package.json');
  });

  it('requires a person, because no algorithm can answer for one', async () => {
    const root = await fixture();
    const result = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests', '--command', '["npm","test"]']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics[0].code).toBe('XFORGE_VERIFICATION_ARGUMENTS_REQUIRED');
  });

  it('refuses a command that is not an explicit argv list', async () => {
    const root = await fixture();
    /* Splitting a string would guess where the arguments are, and would split a quoted argument
       wrongly and silently — the class of error this command exists to remove. */
    const result = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests', '--command', 'npm test', '--by', 'alex']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics[0].code).toBe('XFORGE_VERIFICATION_COMMAND_INVALID');
  });

  it('refuses to write a Manifest that would stop validating, and leaves the old one intact', async () => {
    const root = await fixture();
    const before = await manifest(root);

    const result = await runCli(root, ['verification', 'declare', '--gate-name', 'Not A Gate', '--command', '["x"]', '--by', 'alex']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_VERIFICATION_WRITE_REFUSED');
    /* The whole point: this command must not be able to create the deadlock it exists to prevent. */
    expect(await manifest(root)).toBe(before);
    expect((await runCli(root, ['check'])).code).toBe(0);
  });
});

describe('a fail-closed deny leaves a way out of itself', () => {
  /** The exact corruption a live run produced: one level short, swallowing the next block. */
  async function breakManifest(root: string): Promise<void> {
    const current = await manifest(root);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(root, 'xforge', 'manifest.yaml'),
      `${current}verification:\n  unit-tests:\n    - command: [npm, test]\n  mcpServers:\n    - enterprise-approvals\n`,
    );
  }

  async function decide(root: string, payload: Record<string, unknown>): Promise<string> {
    const result = await runCliWithStdin(root, ['hook', 'dispatch', '--target', 'claude', '--event', 'agent.tool.before'], JSON.stringify(payload));
    return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
  }

  it('permits a read and an xforge invocation, and nothing else', async () => {
    const root = await fixture();
    await clearVerification(root);
    await breakManifest(root);
    expect((await runCli(root, ['state'])).json.diagnostics[0].code).toBe('XFORGE_SCHEMA_INVALID');

    /* Diagnosis and repair. A read changes nothing; `xforge` is the tool being repaired. */
    expect(await decide(root, { tool_name: 'Read', tool_input: { file_path: 'xforge/manifest.yaml' } })).toBe('allow');
    expect(await decide(root, { tool_name: 'Bash', tool_input: { command: 'xforge state' } })).toBe('allow');

    /* Everything else stays denied — the relaxation buys repair, not an ungoverned session. */
    expect(await decide(root, { tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } })).toBe('deny');
    expect(await decide(root, { tool_name: 'Bash', tool_input: { command: 'npm install anything' } })).toBe('deny');
  });

  it('refuses a shell call that only begins with xforge', async () => {
    const root = await fixture();
    await clearVerification(root);
    await breakManifest(root);

    /* `xforge version && rm -rf /` starts with `xforge` too, so the first metacharacter
       disqualifies the whole class rather than inviting a parser to adjudicate it. */
    expect(await decide(root, { tool_name: 'Bash', tool_input: { command: 'xforge state && rm -rf /tmp/x' } })).toBe('deny');
    expect(await decide(root, { tool_name: 'Bash', tool_input: { command: 'xforge state | tee out' } })).toBe('deny');
    expect(await decide(root, { tool_name: 'Bash', tool_input: { command: 'xforge state; echo done' } })).toBe('deny');
  });
});
