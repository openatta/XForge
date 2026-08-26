import { describe, expect, it } from 'vitest';
import { matchPathGlob, matchPathGlobFallback, ruleApplies } from '../../src/core/governance.js';
import { matchesWritePath } from '../../src/core/work-packages.js';
import { golden } from '../golden.js';

/**
 * Four things in this package answer a question about paths, and no two of them answer the same one.
 *
 * They accumulated separately and the disagreement has already cost a defect: a `must` Rule scoped
 * to `src/**` reached nothing in a monorepo, because `ruleApplies` compares that pattern with the
 * paths a *Change declares*, while the Adapters hand the identical string to the host as a file
 * glob. Nobody chose that; the two were written at different times for different callers.
 *
 * The instinct is to merge them. This is the differential that has to come first, because a merge
 * is only safe once the differences are known to be accidental — and some of them are not:
 *
 * - `matchPathGlob` (`core/governance.ts`) — picomatch when it is available, for PermissionPolicy
 *   `match.paths` against a repository-relative path. Segment-aware.
 * - `matchPathGlobFallback` (same module) — the dependency-free implementation of the same
 *   semantics, used when picomatch is absent. It must agree with the above or the dispatcher's
 *   answer depends on whether an optional dependency installed.
 * - `matchesWritePath` (`core/work-packages.ts`) — a changed path against a declared write
 *   boundary. Its own regex compiler.
 * - `ruleApplies` (`core/governance.ts`) — not a matcher at all: a *pattern-against-pattern*
 *   relation asking whether a Rule's scope and a Change's scope share a root. It takes no file path
 *   and cannot be compared here, which is itself the finding — a reader who assumes the same
 *   meaning as the other three is the reader who wrote `src/**` into a monorepo Rule.
 *
 * The recorded table is the deliverable. Each row is a disagreement, and each has to be read and
 * either accepted as intentional or fixed; the golden is what stops one being introduced silently
 * in the meantime.
 */

/** Patterns the product actually uses, plus the shapes where glob dialects usually part company. */
const PATTERNS = [
  'src/**', 'src/*', 'src', 'xforge/**', 'xforge/constitution.md', 'xforge/flows/**',
  'apps/*/src/**', 'packages/*/src/**', '**/src/**', '**', '**/*.ts', '*.md',
  'a/**/b', 'a/**', '**/b', 'docs/**/*.md', 'src/**/', 'src/a?c.ts', 'src/[ab].ts',
];

const VALUES = [
  'src', 'src/a.ts', 'src/a/b.ts', 'src/a/b/c.ts', 'srcfoo/a.ts', 'a.ts', 'README.md',
  'apps/web/src/a.ts', 'apps/web/lib/a.ts', 'packages/core/src/a.ts',
  'xforge/constitution.md', 'xforge/flows/solid.yaml', 'xforgeX/constitution.md',
  'a/b', 'a/x/b', 'a/x/y/b', '.hidden/a.ts', 'src/.hidden.ts', 'docs/a/b.md',
  'src/abc.ts', 'src/a.ts', 'src/b.ts',
];

interface Row {
  pattern: string;
  value: string;
  glob: boolean;
  fallback: boolean;
  writePath: boolean;
}

function rows(): Row[] {
  const out: Row[] = [];
  for (const pattern of PATTERNS) {
    for (const value of VALUES) {
      out.push({
        pattern,
        value,
        glob: matchPathGlob(pattern, value),
        fallback: matchPathGlobFallback(pattern, value),
        writePath: matchesWritePath(value, pattern),
      });
    }
  }
  return out;
}

describe('path-matching semantics', () => {
  it('keeps the policy matcher and its dependency-free fallback in exact agreement', () => {
    /*
     * The one pair that may not differ at all. `matchPathGlob` uses picomatch when it resolves and
     * this fallback when it does not, so any disagreement means the governance dispatcher decides a
     * tool call differently depending on whether an optional dependency happened to install — and
     * the audit chain would record whichever answer it got.
     */
    const disagreements = rows()
      .filter((row) => row.glob !== row.fallback)
      .map((row) => `${row.pattern} vs ${row.value}: picomatch=${row.glob} fallback=${row.fallback}`);
    expect(disagreements).toEqual([]);
  });

  it('records where the write-boundary matcher parts from the policy matcher', async () => {
    const differing = rows().filter((row) => row.glob !== row.writePath);
    const table = differing
      .map((row) => `${row.pattern.padEnd(24)} ${row.value.padEnd(26)} policy=${String(row.glob).padEnd(5)} writePath=${row.writePath}`)
      .sort();
    const { actual, expected } = await golden('path-semantics/policy-vs-write-path.txt', `${table.join('\n')}\n`);
    expect(actual).toBe(expected);
  });

  it('refuses a write path whose glob characters it would honour literally', () => {
    /*
     * The one difference in the table above that is a trap rather than a choice, closed at plan
     * time. Kept as a differential assertion rather than only as a diagnostic test, because the
     * reason it is a trap is precisely that the *other* matcher reads the same string differently.
     */
    expect(matchPathGlob('src/[ab].ts', 'src/a.ts')).toBe(true);
    expect(matchesWritePath('src/a.ts', 'src/[ab].ts')).toBe(false);
    expect(matchesWritePath('src/[ab].ts', 'src/[ab].ts')).toBe(true);
    expect(matchPathGlob('src/a?c.ts', 'src/abc.ts')).toBe(true);
    expect(matchesWritePath('src/abc.ts', 'src/a?c.ts')).toBe(false);
  });

  it('shows that the Rule scope relation is not a path matcher', () => {
    /*
     * The finding that cost a live Major run its `must` Rule, stated as an executable fact rather
     * than as prose. `ruleApplies` never sees `apps/web/src/a.ts`; it compares `src/**` with what
     * `change.yaml` declares, and two scopes match only when one root contains the other.
     */
    const rule = { id: 'r', severity: 'must' as const, instruction: '', modules: [], paths: ['src/**'], stages: [], gateRefs: [], policyRefs: [], approvalRefs: [] };
    const change = (paths: string[]) => ({ flow: 'solid', classification: { risk: 'medium', security: false, privacy: false, publicApi: false, dataMigration: false }, scope: { modules: [], paths } } as never);

    /* A Change whose files all live under `src/` — but which declares its scope by module path. */
    expect(ruleApplies(rule, change(['apps/web/**']))).toBe(false);
    expect(matchPathGlob('src/**', 'apps/web/src/a.ts')).toBe(false);
    /* …and the same Rule reaches a Change that declares `src/**`, or anything rooted inside it. */
    expect(ruleApplies(rule, change(['src/**']))).toBe(true);
    expect(ruleApplies(rule, change(['src/core/**']))).toBe(true);
    /* Containment runs both ways, which no file-glob matcher does: a Change scoped to the whole
       repository picks the Rule up even though `src/**` does not match `.`-rooted anything. */
    expect(ruleApplies(rule, change(['src']))).toBe(true);
  });
});
