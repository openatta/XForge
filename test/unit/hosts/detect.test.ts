// design: cli §5.4 — 探测的三路证据：会话变量 > 用户配置目录 > PATH；探不到不是判决。
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect } from '../../../src/assemble/detect.js';
import { provider } from '../../../src/hosts/index.js';

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'xforge-detect-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一个只有指定可执行文件的 PATH。 */
function pathWith(binaries: string[]): string {
  const bin = scratch();
  for (const b of binaries) {
    writeFileSync(join(bin, b), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, b), 0o755);
  }
  return bin;
}

const claude = provider('claude');
const codex = provider('codex');
const home = (): string => scratch();

describe('host detection', () => {
  it('an empty machine detects nothing — and says so without pretending', () => {
    const env = { PATH: pathWith([]) };
    expect(detect(claude, env, home())).toEqual({ available: false, evidence: 'not detected' });
    expect(detect(codex, env, home())).toEqual({ available: false, evidence: 'not detected' });
  });

  it('a binary on PATH is evidence, and it is named', () => {
    const env = { PATH: pathWith(['claude']) };
    expect(detect(claude, env, home())).toEqual({ available: true, evidence: 'found: claude on PATH' });
    expect(detect(codex, env, home()).available).toBe(false);
  });

  it('the user-level config directory is stronger evidence than PATH', () => {
    const h = home();
    mkdirSync(join(h, '.codex'));
    const found = detect(codex, { PATH: pathWith(['codex']), HOME: h }, h);
    expect(found).toEqual({ available: true, evidence: 'found: ~/.codex' });
  });

  it('running inside a host settles it, whatever the disk says', () => {
    const env = { PATH: pathWith([]), CLAUDECODE: '1' };
    expect(detect(claude, env, home())).toEqual({ available: true, evidence: 'found: this session' });
    expect(detect(codex, { PATH: pathWith([]), CODEX_HOME: '/somewhere' }, home()).evidence).toBe('found: this session');
  });

  it('a directory that is not executable is not a binary', () => {
    const bin = scratch();
    mkdirSync(join(bin, 'claude'));
    expect(detect(claude, { PATH: `${bin}:${scratch()}` }, home()).available).toBe(false);
  });
});
