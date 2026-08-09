import { cp } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, temporaryDirectory, xforgeRoot } from '../helpers.js';

describe('minimal example project', () => {
  it('reads a Protocol 1 project portably and blocks managed writes', async () => {
    const root = await temporaryDirectory('xforge-example-');
    await cp(path.join(xforgeRoot, 'test', 'fixtures', 'minimal-project'), root, { recursive: true });
    const state = await runCli(root, ['state']);
    expect(state.code).toBe(1);
    expect(state.json.data.specs).toEqual(['example/spec.md']);
    expect(state.json.data.project.compatibility.mode).toBe('portable');
    expect((await runCli(root, ['check'])).code).toBe(1);
    const installed = await runCli(root, ['install']);
    expect(installed.code).toBe(1);
    expect(installed.json.changes).toEqual([]);
  });
});
