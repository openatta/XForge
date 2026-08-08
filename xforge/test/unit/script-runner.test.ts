import { describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/project-loader.js';
import { runProjectScript } from '../../src/runners/script.js';
import { fixture, runCli, updateYaml, write } from '../helpers.js';

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
});
