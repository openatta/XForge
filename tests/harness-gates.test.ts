import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function runGate(script: string): { code: number; output: string } {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'tests', 'live-engine', script)], {
    cwd: repositoryRoot, encoding: 'utf8',
  });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/*
 * The harness's own gates, run by the suite rather than by memory.
 *
 * `check-coverage.mjs` has existed for some time, is described in two places in the RUNBOOK, and is
 * referenced by four source comments as the thing that stops a Skill being marked covered while
 * nothing runs it. It was wired into no script: `npm test`, `npm run test:product` and `npm run
 * verify` all pass without it. A gate that only runs when somebody remembers to run it is a gate
 * that is not enforcing anything, which is the same failure it was written to prevent one level up.
 *
 * `check-vocabulary.mjs` is new and would have inherited exactly that fate.
 */
describe('live-engine harness gates', () => {
  it('every Skill the project ships is covered by a scenario that can actually run', () => {
    const { code, output } = runGate('check-coverage.mjs');
    expect(code, output).toBe(0);
  });

  it('no cold scenario is told what it exists to discover, and no harness term ships to users', () => {
    const { code, output } = runGate('check-vocabulary.mjs');
    expect(code, output).toBe(0);
  });
});
