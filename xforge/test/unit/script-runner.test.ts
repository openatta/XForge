import { describe, expect, it } from 'vitest';
import { MAX_GATE_OUTPUT_BYTES } from '../../src/constants.js';
import { XForgeError } from '../../src/core/errors.js';
import { loadProject } from '../../src/core/project-loader.js';
import { runProjectScript } from '../../src/runners/script.js';
import { fixture, runCli, updateYaml, write } from '../helpers.js';

/**
 * Registers a Node project Script (`id`) with the given `script.yaml` spec overrides and body,
 * then runs `xforge install` so `runProjectScript`'s lock-freshness check (it throws
 * XFORGE_LOCK_STALE otherwise) does not reject the run. Mirrors the `python-example` setup already
 * used above, generalised for the runtime-behavior tests below.
 */
async function registerNodeScript(root: string, id: string, body: string, options: { timeoutSeconds?: number; entry?: string } = {}): Promise<void> {
  const entry = options.entry ?? 'main.mjs';
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scripts.push(id); });
  await write(root, `xforge/scripts/${id}/script.yaml`, [
    'apiVersion: xforge.dev/v1alpha1', 'kind: Script', 'metadata:', `  name: ${id}`, '  version: 1',
    'spec:', '  runtime: node', `  entry: ${entry}`, '  arguments: []', '  workingDirectory: .',
    `  timeoutSeconds: ${options.timeoutSeconds ?? 30}`, '  input: none', '  output: none', '  sideEffects: none', '',
  ].join('\n'));
  await write(root, `xforge/scripts/${id}/${entry}`, body);
  expect((await runCli(root, ['install'])).code).toBe(0);
}

describe('project Script runner', () => {
  it('transpiles and runs the default TypeScript path without project writes', async () => {
    const root = await fixture();
    const result = await runProjectScript(await loadProject(root), 'project-context');
    expect(result).toMatchObject({ runtime: 'node', exitCode: 0, timedOut: false });
    expect(JSON.parse(result.stdout)).toMatchObject({ root, detected: expect.any(Array), manifestBytes: expect.any(Number) });
    expect(result.command[1]).toBe('<transpiled-typescript>');
  });

  it('supports an explicitly selected Python project Script', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scripts.push('python-example'); });
    await write(root, 'xforge/scripts/python-example/script.yaml', [
      'apiVersion: xforge.dev/v1alpha1', 'kind: Script', 'metadata:', '  name: python-example', '  version: 1',
      'spec:', '  runtime: python', '  entry: main.py', '  arguments: []', '  workingDirectory: .',
      '  timeoutSeconds: 30', '  input: none', '  output: JSON', '  sideEffects: none', '',
    ].join('\n'));
    await write(root, 'xforge/scripts/python-example/main.py', 'import json\nprint(json.dumps({"runtime": "python"}))\n');
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runProjectScript(await loadProject(root), 'python-example');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ runtime: 'python' });
  });

  /*
   * "Ignores SIGTERM" is a POSIX signal-handling concept with no real Windows equivalent: Node
   * emulates ChildProcess#kill('SIGTERM') on Windows as an unconditional forceful terminate that a
   * child cannot intercept via process.on('SIGTERM', ...), so this exact scenario doesn't test a
   * meaningful Windows behavior, and spawning a genuinely SIGTERM-immune Windows child would need a
   * different mechanism entirely. Skipped only on win32; the SIGKILL-escalation path this exercises
   * on POSIX is still covered there (ubuntu-latest, macos-latest).
   */
  it.skipIf(process.platform === 'win32')('kills a script that outlives its timeout, even one that ignores SIGTERM, and reports timedOut', async () => {
    const root = await fixture();
    await registerNodeScript(root, 'never-ending', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", { timeoutSeconds: 1 });
    const result = await runProjectScript(await loadProject(root), 'never-ending');
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  /* Windows equivalent of the test above, without the POSIX-only "ignores SIGTERM" trick: still
     verifies the basic timeout/kill mechanism actually terminates a runaway script there. */
  it('kills a script that outlives its timeout and reports timedOut', async () => {
    const root = await fixture();
    await registerNodeScript(root, 'never-ending-plain', 'setInterval(() => {}, 1000);', { timeoutSeconds: 1 });
    const result = await runProjectScript(await loadProject(root), 'never-ending-plain');
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  it('caps stdout at MAX_GATE_OUTPUT_BYTES and flags the result as truncated', async () => {
    const root = await fixture();
    await registerNodeScript(root, 'noisy', "process.stdout.write('x'.repeat(200000));");
    const result = await runProjectScript(await loadProject(root), 'noisy');
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(MAX_GATE_OUTPUT_BYTES);
  });

  it('pipes provided stdin content through to the running script', async () => {
    const root = await fixture();
    await registerNodeScript(root, 'echoer', [
      'let data = "";',
      'process.stdin.on("data", (chunk) => { data += chunk; });',
      'process.stdin.on("end", () => { process.stdout.write(data); });',
    ].join('\n'));
    const result = await runProjectScript(await loadProject(root), 'echoer', [], { stdin: 'hello-from-test-stdin' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-from-test-stdin');
  });

  it('fails cleanly (a thrown XForgeError, not an uncaught exception) on invalid TypeScript source', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scripts.push('broken-ts'); });
    await write(root, 'xforge/scripts/broken-ts/script.yaml', [
      'apiVersion: xforge.dev/v1alpha1', 'kind: Script', 'metadata:', '  name: broken-ts', '  version: 1',
      'spec:', '  runtime: node', '  entry: main.ts', '  arguments: []', '  workingDirectory: .',
      '  timeoutSeconds: 10', '  input: none', '  output: none', '  sideEffects: none', '',
    ].join('\n'));
    // Syntactically invalid: `ts.transpileModule` still runs the parser and reports this as a
    // syntactic diagnostic even without cross-file type checking.
    await write(root, 'xforge/scripts/broken-ts/main.ts', 'const value: number = ;\n');
    expect((await runCli(root, ['install'])).code).toBe(0);
    const project = await loadProject(root);
    let caught: unknown = null;
    try {
      await runProjectScript(project, 'broken-ts');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(XForgeError);
    expect((caught as XForgeError).diagnostics[0]?.code).toBe('XFORGE_SCRIPT_COMPILE_FAILED');
    expect((caught as XForgeError).diagnostics[0]?.message).toBeTruthy();
  });

  it('only forwards the fixed env allowlist to the child, never an arbitrary parent-process variable', async () => {
    const root = await fixture();
    await registerNodeScript(root, 'env-probe', [
      'process.stdout.write(JSON.stringify({',
      '  hasPath: typeof process.env.PATH === "string" && process.env.PATH.length > 0,',
      '  secret: process.env.XFORGE_TEST_SCRIPT_SECRET_PROBE ?? null,',
      '}));',
    ].join('\n'));
    process.env.XFORGE_TEST_SCRIPT_SECRET_PROBE = 'must-not-leak-to-child';
    try {
      const result = await runProjectScript(await loadProject(root), 'env-probe');
      expect(result.exitCode).toBe(0);
      // PATH is on script.ts's fixed allowlist (PATH, SystemRoot, TMPDIR, TEMP, TMP, HOME) and must
      // reach the child; an arbitrary test-only variable, set only in the parent process and never
      // on that list, must not.
      expect(JSON.parse(result.stdout)).toEqual({ hasPath: true, secret: null });
    } finally {
      delete process.env.XFORGE_TEST_SCRIPT_SECRET_PROBE;
    }
  });
});
