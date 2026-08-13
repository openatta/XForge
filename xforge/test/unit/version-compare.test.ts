import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/core/project-loader.js';

/**
 * `compareVersions` decides whether `xforge update` may reconcile a Manifest's declared CLI pin up
 * to the running CLI's version. Getting the ordering wrong in the "older" direction turns the
 * upgrade channel into a silent downgrade — the exact failure the exact-version pin exists to
 * prevent — so the ordering is pinned here directly rather than only through the CLI-level
 * upgrade tests, which cannot reach arbitrary version pairs.
 */
describe('declared CLI version ordering', () => {
  const older = (left: string, right: string): void => {
    expect(compareVersions(left, right), `${left} < ${right}`).toBeLessThan(0);
    expect(compareVersions(right, left), `${right} > ${left}`).toBeGreaterThan(0);
  };

  it('orders release cores numerically, not lexically', () => {
    older('0.7.7', '0.7.8');
    older('0.7.9', '0.7.10');
    older('0.9.0', '0.10.0');
    older('0.7.8', '9.9.9');
    expect(compareVersions('0.7.8', '0.7.8')).toBe(0);
  });

  it('ranks a release above its own prereleases, in both directions', () => {
    /* rc -> GA must read as an upgrade, and GA -> rc as a downgrade; an engine that gets this
       backwards either refuses a legitimate upgrade or performs a silent downgrade. */
    older('0.8.0-rc.1', '0.8.0');
    older('0.7.8', '0.8.0-rc.1');
    older('0.7.8-rc.1', '0.7.8');
  });

  it('collates numeric prerelease identifiers numerically', () => {
    /* The regression this guards: a plain lexical compare puts 'rc.10' below 'rc.2', so a project
       pinned at rc.10 would accept an rc.2 CLI as an upgrade. Double-digit rc numbers are ordinary. */
    older('0.8.0-rc.2', '0.8.0-rc.10');
    older('0.8.0-rc.9', '0.8.0-rc.11');
    expect(compareVersions('0.8.0-rc.1', '0.8.0-rc.1')).toBe(0);
  });

  it('keeps the whole prerelease when it contains hyphens', () => {
    /* `split('-', 2)` discards the remainder rather than keeping it, which collapses every
       hyphenated prerelease in a series to one value and makes them compare equal. */
    older('1.0.0-alpha-1', '1.0.0-alpha-2');
    expect(compareVersions('1.0.0-alpha-1', '1.0.0-alpha-1')).toBe(0);
  });

  it('orders alphabetic prerelease channels', () => {
    older('0.8.0-alpha.1', '0.8.0-beta.1');
    older('0.8.0-beta.2', '0.8.0-rc.1');
    older('1.0.0-1', '1.0.0-alpha');
    older('0.8.0-rc.1', '0.8.0-rc.1.1');
  });

  it('never reports an older running CLI as newer', () => {
    /* The one property that actually matters for safety: whatever the shape, the reconciliation
       gate (`compareVersions(declared, CLI_VERSION) < 0`) must not fire when the running CLI is
       behind the pin. */
    /* Strictly descending. Note 0.9.10-rc.1 outranks 0.9.9: the core segments decide first, and
       0.10 > 0.9 numerically — a prerelease only ever loses to its *own* release. */
    const descending = ['1.0.0', '1.0.0-rc.10', '1.0.0-rc.2', '1.0.0-beta.1', '0.9.10-rc.1', '0.9.9', '0.9.9-rc.1'];
    for (let index = 0; index < descending.length - 1; index += 1) {
      for (let next = index + 1; next < descending.length; next += 1) {
        expect(
          compareVersions(descending[index]!, descending[next]!),
          `${descending[index]} must outrank ${descending[next]}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
