import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { MAX_GATE_OUTPUT_BYTES } from '../../src/constants.js';
import { loadProject } from '../../src/core/project-loader.js';
import { runProjectScript } from '../../src/runners/script.js';
import { fixture, runCli, updateYaml, write } from '../helpers.js';

/** Registers a node Script (installing so the lock matches) and returns its id. */
async function addNodeScript(root: string, id: string, entry: string, body: string, spec: Record<string, unknown> = {}): Promise<string> {
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { (manifest.scripts ??= []).push(id); });
  await write(root, `xforge/scripts/${id}/script.yaml`, stringify({
    apiVersion: 'xforge.dev/v1alpha1', kind: 'Script', metadata: { name: id, version: 1 },
    spec: {
      runtime: 'node', entry, arguments: [], workingDirectory: '.', timeoutSeconds: 30,
      input: 'none', output: 'JSON', sideEffects: 'none', ...spec,
    },
  }));
  await write(root, `xforge/scripts/${id}/${entry}`, body);
  expect((await runCli(root, ['install'])).code).toBe(0);
  return id;
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

  it('passes the dispatch payload through stdin to a Script that reads it', async () => {
    const root = await fixture();
    await addNodeScript(root, 'echo-stdin', 'echo.mjs', 'process.stdin.pipe(process.stdout);\n');
    const result = await runProjectScript(await loadProject(root), 'echo-stdin', [], { stdin: 'hello-payload' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-payload');
  });

  it('kills a Script that exceeds its timeout and reports it as timed out', async () => {
    const root = await fixture();
    await addNodeScript(root, 'busy-loop', 'busy.mjs', 'setInterval(() => {}, 1000);\n', { timeoutSeconds: 1 });
    const result = await runProjectScript(await loadProject(root), 'busy-loop');
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(1000);
  });

  it('bounds stdout and stderr at the output cap and flags truncation', async () => {
    const root = await fixture();
    await addNodeScript(root, 'verbose', 'verbose.mjs', [
      'process.stdout.write("x".repeat(70000));', 'process.stderr.write("y".repeat(70000));', '',
    ].join('\n'));
    const result = await runProjectScript(await loadProject(root), 'verbose');
    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).toBe('x'.repeat(MAX_GATE_OUTPUT_BYTES));
    expect(result.stderr).toBe('y'.repeat(MAX_GATE_OUTPUT_BYTES));
  });

  it('rejects a TypeScript Script that does not compile with a diagnostic instead of running it', async () => {
    const root = await fixture();
    await addNodeScript(root, 'broken', 'broken.ts', 'const broken = ;\n');
    await expect(runProjectScript(await loadProject(root), 'broken')).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'XFORGE_SCRIPT_COMPILE_FAILED' })],
    });
  });
});
