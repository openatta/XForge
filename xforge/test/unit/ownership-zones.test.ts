import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  OWNERSHIP_ZONES, UPGRADE_ROOT, UPGRADE_SENTINEL, askPaths, guardedPaths, neverTouchPaths, policyGlob,
  transactionPrefixes, zoneFor,
  type AgentWrite, type OwnershipZone, type ZoneEntry, type ZoneId,
} from '../../src/core/ownership-zones.js';
import { MANAGED_PREFIXES } from '../../src/core/upgrade.js';
import { scaffoldPayload } from '../helpers.js';

/**
 * Which files XForge owns was written down in four places that could not see each other, and they
 * drifted: `xforge/flows/` was denied to Agents and named in the Rule while the upgrade transaction
 * did not know the directory existed. `core/ownership-zones.ts` is now the one table, but the
 * PermissionPolicy and Rule still ship as yaml — a host has to be able to read them without running
 * the CLI — so the copy remains and can still drift.
 *
 * Both payload files carry a comment saying they must stay in exact 1:1 alignment. This file is what
 * turns that sentence into something that goes red.
 */

const payload = (...segments: string[]) => path.join(scaffoldPayload, 'xforge', 'scaffold', ...segments);

async function readPaths(file: string, pick: (document: any) => unknown): Promise<string[]> {
  const parsed = parse(await readFile(file, 'utf8'));
  const found = pick(parsed);
  if (!Array.isArray(found)) throw new Error(`${file} has no path list where this test expected one.`);
  return found.map(String);
}

/*
 * Sets, not arrays. These lists are read by a glob matcher that does not care what order they are
 * in, so a test that compared sequences would fail on a reordering that changes nothing and would
 * report a genuine omission as an off-by-one somewhere in the middle of a diff. What a reader needs
 * told is which path is on one side and not the other, and which of the two files to edit.
 */
function expectSameSet(
  actual: readonly string[],
  expected: readonly string[],
  labels: { actual: string; expected: string },
): void {
  const report = [
    ...expected.filter((entry) => !actual.includes(entry))
      .map((entry) => `${entry} is in ${labels.expected} but not in ${labels.actual}`),
    ...actual.filter((entry) => !expected.includes(entry))
      .map((entry) => `${entry} is in ${labels.actual} but not in ${labels.expected}`),
  ];
  expect(
    report,
    `${labels.actual} and ${labels.expected} must name the same paths. The table in `
    + 'src/core/ownership-zones.ts is the source of both: if the path is genuinely owned, add its '
    + 'entry to the table and mirror the glob into the payload yaml; if it is not, delete it from '
    + 'the yaml. Never edit only one of the two.',
  ).toEqual([]);
}

describe('the ownership table and the payload policies that mirror it', () => {
  it('denies exactly the paths protected-files denies', async () => {
    const policy = await readPaths(payload('policies', 'protected-files.yaml'), (document) => document?.spec?.match?.paths);
    expectSameSet(guardedPaths, policy, {
      actual: "the table's `agentWrite: 'deny'` entries",
      expected: "protected-files' spec.match.paths",
    });
  });

  it('asks on exactly the paths protected-manifest asks on', async () => {
    const policy = await readPaths(payload('policies', 'protected-manifest.yaml'), (document) => document?.spec?.match?.paths);
    expectSameSet(askPaths, policy, {
      actual: "the table's `agentWrite: 'ask'` entries",
      expected: "protected-manifest's spec.match.paths",
    });
  });

  it('scopes the Rule to the union of the two policies, so nothing is claimed that nothing enforces', async () => {
    /*
     * The Rule tells an Agent where the boundary is; the two policies are what actually stop it. A
     * path in the Rule that neither policy covers is worse than an absent one: it reports itself as
     * guarded in every reachability report while the write goes through unremarked.
     */
    const rule = await readPaths(
      payload('rules', 'governance-assets-are-integrator-only.yaml'),
      (document) => document?.spec?.scope?.paths,
    );
    expectSameSet([...guardedPaths, ...askPaths], rule, {
      actual: "the table's deny and ask entries together",
      expected: "governance-assets-are-integrator-only's spec.scope.paths",
    });
  });

  it('names the policies that enforce it, so the Rule and this test agree on what to compare', async () => {
    const refs = await readPaths(
      payload('rules', 'governance-assets-are-integrator-only.yaml'),
      (document) => document?.spec?.enforcement?.policyRefs,
    );
    expect(refs.sort()).toEqual(['protected-files', 'protected-manifest']);
  });
});

describe('what the table derives', () => {
  it('is what an upgrade stages, so a first-class resource tree cannot be left out of the transaction', () => {
    /*
     * `xforge/scripts/<id>/script.yaml` is loaded by `core/resource-loader.ts`, shipped in the
     * payload and seeded by `init`, and until the managed set was derived from this table no upgrade
     * ever reached it — the same omission `xforge/flows/` lived under for several releases.
     */
    expect([...transactionPrefixes].sort()).toEqual(['xforge/flows/', 'xforge/scaffold/', 'xforge/scripts/']);
    expect([...MANAGED_PREFIXES]).toEqual([...transactionPrefixes]);
  });

  it('tells a merging Agent about the record as well as the denied paths', () => {
    /*
     * `xforge/changes/` is `open` — the lifecycle Skills write there all day — and an upgrade merge
     * still has no business in it. A "## Never" list built from the deny list alone would leave the
     * Change history looking like fair game to the one Agent most likely to rewrite it.
     */
    expect(neverTouchPaths).toContain('xforge/changes/**');
    expect(neverTouchPaths).toContain('xforge/architecture.md');
    /*
     * And the reverse: `deny` does not imply never-touch either. `xforge/flows/**` is denied to an
     * Agent's ordinary tool call and is still a tree this merge carries, so listing it under "Never"
     * would forbid the one job the merge was staged to do. The prompt says what is actually true of
     * a Flow -- that adopting one invalidates the approvals of any Change still running under it, so
     * it is a person's decision -- which is a different instruction from "do not touch".
     */
    expect(neverTouchPaths).not.toContain('xforge/flows/**');
    expect(neverTouchPaths).not.toContain('xforge/scaffold/**');
    expect(neverTouchPaths).not.toContain('xforge/scripts/**');
    /* The two named exclusions, each because a narrower rule already covers the path. */
    expect(neverTouchPaths).not.toContain('xforge/manifest.yaml');
    expect(neverTouchPaths).not.toContain('xforge/.upgrade/**');
  });

  it('puts the contract baseline where the Spec baseline already is', () => {
    /*
     * `xforge/contracts/` is the same kind of thing as `xforge/specs/`: a canonical record that
     * changes only by a merged delta, so an Agent writing it directly leaves every other package
     * implementing against an interface nothing agreed to.
     *
     * `neverTouch` is the half that is easy to get wrong. A Scaffold rollback restores the trees the
     * upgrade transaction carries, and the interface history of a project is not one of them --
     * rolling the CLI back to an older release must not roll back what the project's modules promise
     * each other. That is the same reason `xforge/specs/` and `xforge/changes/` sit in this zone,
     * and it is why the baseline must not be reachable from `transactionPrefixes`.
     */
    const zone = zoneFor('xforge/contracts/http/orders.openapi.yaml');
    expect(zone?.id).toBe('record');
    expect(zone?.neverTouch).toBe(true);
    expect(zone?.inTransaction).toBe('none');
    expect(guardedPaths).toContain('xforge/contracts/**');
    expect(neverTouchPaths).toContain('xforge/contracts/**');
    expect(transactionPrefixes).not.toContain('xforge/contracts/');
  });

  it('keeps a glob out of the list twice when it qualifies on two grounds', () => {
    /* `xforge/specs/` is both denied and inside the `neverTouch` record. A duplicated glob in a
       rendered policy is a second rule that can be edited out of step with the first. */
    expect(new Set(neverTouchPaths).size).toBe(neverTouchPaths.length);
    expect(new Set(guardedPaths).size).toBe(guardedPaths.length);
  });
});

describe('resolving a path to its zone', () => {
  it('reads a file by the most specific entry that claims it, not the first', () => {
    /*
     * A snapshot holds a copy of the Scaffold, so `xforge/.upgrade/snapshot/xforge/scaffold/...`
     * sits under two prefixes at once. If declaration order decided, the restore point would be read
     * as ordinary managed source and an upgrade would happily stage over its own undo.
     */
    expect(zoneFor(`${UPGRADE_ROOT}snapshot/scaffold/skills/x/SKILL.md`)?.id).toBe('transient');
    expect(zoneFor('xforge/scaffold/skills/x/SKILL.md')?.id).toBe('managed-source');
  });

  it('separates the upgrade transaction question from the tool-call question', () => {
    /*
     * These are the two asymmetries the table exists to hold. `changes/` is writable by Skills and
     * untouchable by an upgrade; `flows/` is managed by an upgrade and closed to every Agent,
     * because a Flow states how many approvals a Stage needs and no Skill authors one.
     */
    const changes = zoneFor('xforge/changes/add-thing/proposal.md');
    expect(changes?.neverTouch).toBe(true);
    expect(changes?.entries.find((entry) => entry.path === 'xforge/changes/')?.agentWrite).toBe('open');

    const flows = zoneFor('xforge/flows/standard.yaml');
    expect(flows?.inTransaction).toBe('full');
    expect(flows?.entries.find((entry) => entry.path === 'xforge/flows/')?.agentWrite).toBe('deny');
  });

  it('claims the in-flight upgrade paths before they exist on disk', () => {
    /* Declared ahead of the step that introduces them on purpose: the snapshot is the restore point
       and the sentinel is what tells every other command an upgrade is half-finished, so an Agent
       overwriting either is a real failure mode from the moment the files appear. */
    expect(zoneFor(UPGRADE_SENTINEL)?.id).toBe('transient');
    expect(guardedPaths).toContain(UPGRADE_SENTINEL);
    expect(guardedPaths).toContain(`${UPGRADE_ROOT}snapshot/**`);
  });

  it('claims nothing outside xforge/', () => {
    expect(zoneFor('src/index.ts')).toBeNull();
    expect(zoneFor('xforge/README.md')).toBeNull();
  });

  it('renders a prefix as a glob and a file as itself, because the yaml matches on globs', () => {
    expect(policyGlob({ path: 'xforge/specs/', kind: 'prefix', agentWrite: 'deny' })).toBe('xforge/specs/**');
    expect(policyGlob({ path: 'xforge/lock.yaml', kind: 'file', agentWrite: 'deny' })).toBe('xforge/lock.yaml');
  });
});

describe('the table itself', () => {
  /*
   * The invariants every consumer reads the table through. A derived list is only as trustworthy as
   * the shape it is derived from, and each of these has a specific way of going wrong quietly: a
   * prefix without its trailing slash matches `xforge/specsomething`, a path outside `xforge/` claims
   * a file this product does not own, and a duplicated zone id makes `zoneFor`'s answer depend on
   * declaration order.
   */
  it('declares each zone once', () => {
    const ids: ZoneId[] = OWNERSHIP_ZONES.map((zone) => zone.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every entry inside xforge/, with prefixes marked as prefixes', () => {
    for (const zone of OWNERSHIP_ZONES as readonly OwnershipZone[]) {
      for (const entry of zone.entries as readonly ZoneEntry[]) {
        expect(entry.path.startsWith('xforge/')).toBe(true);
        expect(entry.path.endsWith('/')).toBe(entry.kind === 'prefix');
        expect(policyGlob(entry).startsWith(entry.path)).toBe(true);
      }
    }
  });

  it('gives every entry one of the three answers about an Agent writing it', () => {
    const allowed: AgentWrite[] = ['deny', 'ask', 'open'];
    for (const zone of OWNERSHIP_ZONES) {
      for (const entry of zone.entries) expect(allowed).toContain(entry.agentWrite);
    }
  });

  it('carries the transaction on managed-source alone', () => {
    /* Everything a rollback restores is here, and nothing else is. The `pin-only` zone travels as
       two version fields rather than as files, which is why it is not a prefix in this list. */
    const full = OWNERSHIP_ZONES.filter((zone) => zone.inTransaction === 'full').map((zone) => zone.id);
    expect(full).toEqual(['managed-source']);
    expect([...transactionPrefixes].sort()).toEqual(['xforge/flows/', 'xforge/scaffold/', 'xforge/scripts/']);
  });
});
