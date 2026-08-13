import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/core/project-loader.js';

describe('compareVersions', () => {
  it('compares numeric segments numerically', () => {
    expect(compareVersions('0.7.10', '0.7.9')).toBe(1);
    expect(compareVersions('0.7.9', '0.7.10')).toBe(-1);
    expect(compareVersions('9', '10')).toBe(-1);
    expect(compareVersions('0.7.8', '0.7.8')).toBe(0);
  });

  it('treats a prerelease as strictly older than its release', () => {
    /* The controlled upgrade channel must never see a running `x.y.z-beta` as "newer than"
       a declared `x.y.z` — that would open a downgrade-shaped "upgrade". */
    expect(compareVersions('0.7.8-beta', '0.7.8')).toBe(-1);
    expect(compareVersions('0.7.8', '0.7.8-beta')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-beta.2')).toBe(1);
  });

  it('falls back to lexical comparison for non-numeric segments', () => {
    expect(compareVersions('0.7.8a', '0.7.8b')).toBe(-1);
    expect(compareVersions('0.7', '0.7.0')).toBe(-1);
  });
});
