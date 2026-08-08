import { cp, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, xforgeRoot } from '../helpers.js';

describe('minimal example project', () => {
  it('loads, checks, and installs for both declared targets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xforge-example-'));
    await cp(path.join(xforgeRoot, 'test', 'fixtures', 'minimal-project'), root, { recursive: true });
    const state = await runCli(root, ['state']);
    expect(state.code).toBe(0);
    expect(state.json.data.specs).toEqual(['example/spec.md']);
    expect((await runCli(root, ['check'])).code).toBe(0);
    const installed = await runCli(root, ['install']);
    expect(installed.code).toBe(0);
    expect(installed.json.data.targets).toEqual(['codex', 'claude']);
  });
});
