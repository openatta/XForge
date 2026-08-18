import path from 'node:path';
import { sha256 } from './hash.js';
import type { Manifest } from '../types.js';

/**
 * Comparing a project's Scaffold against the one the installed CLI ships.
 *
 * `xforge/scaffold/**` is seeded once by `init` and never updated, so a project stays on the assets
 * it was created with for the rest of its life. Every fix to a shipped Skill, Rule or Gate has had
 * to reach existing projects as a bespoke migration in `update` — `migratePlaceholderGates` is one —
 * and anything that cannot be expressed as a targeted rewrite never reached them at all.
 *
 * The obvious repair is a three-way merge, and it cannot be built: `lock.yaml` records the digest of
 * the file *as it stands*, so a project that adapted a Gate overwrote the only record of what was
 * shipped. There is no base to merge from.
 *
 * So this does not merge. It stages the incoming Scaffold beside the current one and classifies
 * every file, and a human or an Agent decides. The classification is the part that can be computed,
 * and computing it is what keeps the decision small: three files that differ is a job someone can
 * do carefully, where seventy-eight files and the word "merge" is not.
 */

export const UPGRADE_DISPOSITIONS = ['identical', 'changed', 'added', 'project-only'] as const;
export type UpgradeDisposition = (typeof UPGRADE_DISPOSITIONS)[number];

export interface UpgradeEntry {
  /** Project-relative, e.g. `xforge/scaffold/skills/xforge-design/SKILL.md`. */
  path: string;
  disposition: UpgradeDisposition;
  currentDigest: string | null;
  incomingDigest: string | null;
}

export interface UnselectedAsset {
  kind: string;
  id: string;
  path: string;
}

export interface UpgradePlan {
  fromVersion: string;
  toVersion: string;
  entries: UpgradeEntry[];
  unselected: UnselectedAsset[];
  counts: Record<UpgradeDisposition, number>;
}

export const SCAFFOLD_PREFIX = 'xforge/scaffold/';

/**
 * Classifies every Scaffold file, by content alone.
 *
 * `project-only` is deliberately not called `removed`. Without a base, a file the project has and
 * the payload does not is either an asset upstream dropped or one the project wrote itself, and
 * nothing here can tell those apart. Naming it after the upstream reading would invite deleting
 * somebody's own Skill on the strength of a guess, so it is named after the one thing that is
 * actually known and nothing ever proposes to remove it.
 */
export function classifyScaffold(
  current: Map<string, Buffer>,
  incoming: Map<string, Buffer>,
): UpgradeEntry[] {
  const entries: UpgradeEntry[] = [];
  const paths = new Set([...current.keys(), ...incoming.keys()]);
  for (const relative of [...paths].sort((left, right) => left.localeCompare(right))) {
    const currentFile = current.get(relative);
    const incomingFile = incoming.get(relative);
    const currentDigest = currentFile ? sha256(currentFile) : null;
    const incomingDigest = incomingFile ? sha256(incomingFile) : null;
    let disposition: UpgradeDisposition;
    if (currentDigest && incomingDigest) disposition = currentDigest === incomingDigest ? 'identical' : 'changed';
    else if (incomingDigest) disposition = 'added';
    else disposition = 'project-only';
    entries.push({ path: relative, disposition, currentDigest, incomingDigest });
  }
  return entries;
}

/**
 * Which directory under `xforge/scaffold/` holds each kind of selectable asset, and which Manifest
 * list selects it. Skills are a directory of files; everything else is one file per id.
 */
const SELECTABLE = [
  { kind: 'skill', directory: 'skills', list: 'skills', directoryAsset: true },
  { kind: 'rule', directory: 'rules', list: 'rules', directoryAsset: false },
  { kind: 'gate', directory: 'gates', list: 'gates', directoryAsset: false },
  { kind: 'flow', directory: 'flows', list: 'flows', directoryAsset: false },
  { kind: 'hook', directory: 'hooks', list: 'hooks', directoryAsset: false },
  { kind: 'policy', directory: 'policies', list: 'policies', directoryAsset: false },
  { kind: 'mcpServer', directory: 'mcp-servers', list: 'mcpServers', directoryAsset: false },
] as const;

/**
 * Assets the incoming Scaffold ships that this project's Manifest does not select.
 *
 * Reported, never adopted. A Skill arriving in the payload is not a decision to run it: selecting it
 * changes what every Agent on the project is told to do, and making that change because a newer
 * package contains a file is the same category error as answering a Gate's verification question on
 * the project's behalf. The upgrade brings the file; a person decides whether it is theirs.
 */
export function unselectedAssets(manifest: Manifest, incoming: Map<string, Buffer>): UnselectedAsset[] {
  const scaffold = (manifest.scaffold ?? {}) as Record<string, unknown>;
  const found: UnselectedAsset[] = [];
  for (const { kind, directory, list, directoryAsset } of SELECTABLE) {
    const selected = new Set((Array.isArray(scaffold[list]) ? scaffold[list] as string[] : []));
    const ids = new Set<string>();
    const prefix = `${SCAFFOLD_PREFIX}${directory}/`;
    for (const relative of incoming.keys()) {
      if (!relative.startsWith(prefix)) continue;
      const rest = relative.slice(prefix.length);
      if (directoryAsset) {
        const [id] = rest.split('/');
        if (id) ids.add(id);
      } else if (rest.endsWith('.yaml') && !rest.includes('/')) {
        ids.add(rest.slice(0, -'.yaml'.length));
      }
    }
    for (const id of [...ids].sort((left, right) => left.localeCompare(right))) {
      if (selected.has(id)) continue;
      found.push({ kind, id, path: `${prefix}${id}${directoryAsset ? '' : '.yaml'}` });
    }
  }
  return found;
}

export function countDispositions(entries: UpgradeEntry[]): Record<UpgradeDisposition, number> {
  const counts = Object.fromEntries(UPGRADE_DISPOSITIONS.map((name) => [name, 0])) as Record<UpgradeDisposition, number>;
  for (const entry of entries) counts[entry.disposition] += 1;
  return counts;
}

export function buildUpgradePlan(input: {
  fromVersion: string;
  toVersion: string;
  manifest: Manifest;
  current: Map<string, Buffer>;
  incoming: Map<string, Buffer>;
}): UpgradePlan {
  const entries = classifyScaffold(input.current, input.incoming);
  return {
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    entries,
    unselected: unselectedAssets(input.manifest, input.incoming),
    counts: countDispositions(entries),
  };
}

/** The staged copy is visible on purpose: an unfinished upgrade should be obvious in a file listing. */
export const stagedDirectory = (version: string): string => `xforge/scaffold-${version}`;
/** The rollback snapshot is not: it is a safety net the project does not work in. */
export const rollbackDirectory = (version: string): string => `xforge/.rollback/scaffold-${version}`;
export const ROLLBACK_MANIFEST = 'xforge/.rollback/manifest.json';
export const UPGRADE_LOG = 'xforge/upgrade-log.md';

export interface RollbackManifest {
  fromVersion: string;
  toVersion: string;
  stagedAt: string;
  completedAt: string | null;
  gitHead: string | null;
  /** Digests of `xforge/scaffold/**` as it stood before staging — what a rollback restores to. */
  before: Record<string, string>;
  /**
   * Digests as they stood when the merge was declared complete. Absent until then.
   *
   * This is what makes a rollback safe to refuse: work done after the upgrade would be destroyed by
   * restoring, and without a post-merge baseline there is no way to notice it happened.
   */
  after: Record<string, string> | null;
}

export function digestMap(files: Map<string, Buffer>): Record<string, string> {
  return Object.fromEntries([...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relative, content]) => [relative, sha256(content)]));
}

/** Paths whose content differs from `expected` — the check that decides whether a rollback is safe. */
export function driftedPaths(expected: Record<string, string>, actual: Record<string, string>): string[] {
  const drifted = new Set<string>();
  for (const [relative, digest] of Object.entries(expected)) {
    if (actual[relative] !== digest) drifted.add(relative);
  }
  for (const relative of Object.keys(actual)) {
    if (!(relative in expected)) drifted.add(relative);
  }
  return [...drifted].sort((left, right) => left.localeCompare(right));
}

/**
 * How much of the plan the merge actually took up.
 *
 * Reported, not judged. Whether a `changed` file should have adopted the incoming version is a
 * question about intent that no digest can answer — a project that deliberately kept its own wording
 * is not behind. What the log records is what is true: this many of the files the plan named now
 * match the incoming Scaffold, and these are the ones that do not.
 */
export function adoptionReport(plan: UpgradePlan, merged: Map<string, Buffer>): {
  considered: number; matching: number; notMatching: string[];
} {
  const notMatching: string[] = [];
  let considered = 0;
  for (const entry of plan.entries) {
    if (entry.disposition !== 'changed' && entry.disposition !== 'added') continue;
    considered += 1;
    const content = merged.get(entry.path);
    if (!content || sha256(content) !== entry.incomingDigest) notMatching.push(entry.path);
  }
  return { considered, matching: considered - notMatching.length, notMatching };
}

export function scaffoldRelative(payloadPath: string): string | null {
  return payloadPath.startsWith(SCAFFOLD_PREFIX) ? payloadPath : null;
}

export function stagedPathFor(version: string, scaffoldPath: string): string {
  return path.posix.join(stagedDirectory(version), scaffoldPath.slice(SCAFFOLD_PREFIX.length));
}
