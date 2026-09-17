// design: live-test §2 — LT-02：每个 oracle 先对参考实现全绿；python3 不在时跳过。
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const python = spawnSync('python3', ['--version']).status === 0;

describe('live oracles', () => {
  it.skipIf(!python)('LT-02 every oracle passes against its reference implementation', () => {
    const out = execFileSync('python3', [join(root, 'test', 'live', 'scenarios', 'invoicely', 'validate.py')], { encoding: 'utf8' });
    expect(out).toContain('quick: ok');
    expect(out).toContain('solid: ok');
    expect(out).toContain('major: ok');
  });
});
