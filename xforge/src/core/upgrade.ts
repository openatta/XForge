import { sha256 } from './hash.js';
import { transactionPrefixes } from './ownership-zones.js';
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

const UPGRADE_DISPOSITIONS = ['identical', 'changed', 'added', 'project-only'] as const;
type UpgradeDisposition = (typeof UPGRADE_DISPOSITIONS)[number];

interface UpgradeEntry {
  /** Project-relative, e.g. `xforge/scaffold/skills/xforge-design/SKILL.md`. */
  path: string;
  disposition: UpgradeDisposition;
  currentDigest: string | null;
  incomingDigest: string | null;
}

interface UnselectedAsset {
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

/* Local to this file: it names the tree the `SELECTABLE` rows below happen to share, which is a
   fact about where those assets are filed rather than a boundary anything outside needs. The
   boundary is `ownership-zones.ts`. */
const SCAFFOLD_PREFIX = 'xforge/scaffold/';

/**
 * Every tree an upgrade proposes changes to, and the one root they are staged beneath.
 *
 * Read, not declared. This used to be a hand-written list, and a hand-written list is how
 * `xforge/flows/` spent several releases outside the transaction: a Flow lives beside the Scaffold
 * rather than inside it, so for as long as this named `xforge/scaffold/` alone a Flow was never
 * brought, never diffed, and never mentioned, while the upgrade log reported "every file the plan
 * named now matches" of a plan that could not name one. `xforge/scripts/` was in the same position
 * until this line started reading `core/ownership-zones.ts`. The list is now a consequence of the
 * `managed-source` zone, so the next tree that becomes a first-class resource source is managed the
 * moment it is added to that table instead of the next time somebody notices the omission.
 *
 * Adoption is still nobody's decision but the project's. A Flow states how many approvals a Stage
 * needs and where a blocker sends the work back; bringing the file is not the same as adopting it,
 * and `complete` measures what the merge kept rather than assuming it kept everything.
 */
export const MANAGED_PREFIXES: readonly string[] = transactionPrefixes;

/** The root every managed tree hangs from, and the prefix staged copies are keyed against. */
export const MANAGED_ROOT = 'xforge/';

export const isManagedPath = (relative: string): boolean =>
  MANAGED_PREFIXES.some((prefix) => relative.startsWith(prefix));

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
  { kind: 'skill', prefix: SCAFFOLD_PREFIX, directory: 'skills', list: 'skills', selectedIn: 'scaffold', directoryAsset: true },
  { kind: 'rule', prefix: SCAFFOLD_PREFIX, directory: 'rules', list: 'rules', selectedIn: 'scaffold', directoryAsset: false },
  { kind: 'gate', prefix: SCAFFOLD_PREFIX, directory: 'gates', list: 'gates', selectedIn: 'scaffold', directoryAsset: false },
  /* Why each row carries its own prefix: not every managed tree lives under `xforge/scaffold/`.
     Flows sit beside it, and this row selected nothing for as long as it assumed otherwise. */
  { kind: 'flow', prefix: MANAGED_ROOT, directory: 'flows', list: 'flows', selectedIn: 'scaffold', directoryAsset: false },
  { kind: 'hook', prefix: SCAFFOLD_PREFIX, directory: 'hooks', list: 'hooks', selectedIn: 'scaffold', directoryAsset: false },
  { kind: 'policy', prefix: SCAFFOLD_PREFIX, directory: 'policies', list: 'policies', selectedIn: 'scaffold', directoryAsset: false },
  { kind: 'mcpServer', prefix: SCAFFOLD_PREFIX, directory: 'mcp-servers', list: 'mcpServers', selectedIn: 'scaffold', directoryAsset: false },
  /* And why each row also carries where its selection list lives. A Script is selected by the
     Manifest's top-level `scripts`, not by `scaffold.scripts`, so a row that assumed one shape for
     every kind would read an absent list, find nothing selected, and report every shipped Script as
     awaiting a decision on every upgrade. `xforge/scripts/` only reached this table when it joined
     the managed set; the misreading it would have caused is the same one the `flow` row above spent
     two releases in. */
  { kind: 'script', prefix: MANAGED_ROOT, directory: 'scripts', list: 'scripts', selectedIn: 'manifest', directoryAsset: true },
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
  const root = manifest as unknown as Record<string, unknown>;
  const found: UnselectedAsset[] = [];
  for (const { kind, prefix: treeRoot, directory, list, selectedIn, directoryAsset } of SELECTABLE) {
    const declared = selectedIn === 'manifest' ? root[list] : scaffold[list];
    const selected = new Set((Array.isArray(declared) ? declared as string[] : []));
    const ids = new Set<string>();
    const prefix = `${treeRoot}${directory}/`;
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

function countDispositions(entries: UpgradeEntry[]): Record<UpgradeDisposition, number> {
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

/**
 * Everything one upgrade is working with, under one root, named without a version.
 *
 * Both halves used to live at the top of `xforge/`: the staged release at `xforge/scaffold-<version>/`
 * and the snapshot at `xforge/.rollback/scaffold-<version>/`. The staged copy was up there on
 * purpose — an unfinished upgrade should be obvious in a listing rather than hidden in a dotfile —
 * and the cost of that argument was a directory one suffix away from `xforge/scaffold/`, sitting
 * next to it, holding a near-identical tree. Every glob over `xforge/scaffold*`, every tab
 * completion and every Agent reading a file listing had to tell them apart by a version number.
 * The visibility is now carried by `xforge/UPGRADING.md`, which says what is in flight in a sentence
 * instead of implying it with a directory, and which `doctor`, `state`, `check` and `transition` all
 * read — a better reader than a file listing, since the person who staged the upgrade is not the one
 * who needed telling.
 *
 * The version leaves the names with it. Exactly one upgrade is ever in flight, `state.json` records
 * both ends of the span, and `complete` and `rollback` were already deriving these paths from that
 * record rather than from anything they knew. A fixed name is one a `.gitignore` and a
 * PermissionPolicy can be written against, which is what lets the snapshot be denied to Agents by
 * `protected-files` instead of by a sentence in the merge prompt.
 */
export const UPGRADE_DIRECTORY = 'xforge/.upgrade';
export const STAGED_DIRECTORY = `${UPGRADE_DIRECTORY}/incoming`;
export const SNAPSHOT_DIRECTORY = `${UPGRADE_DIRECTORY}/snapshot`;
export const UPGRADE_STATE = `${UPGRADE_DIRECTORY}/state.json`;
export const UPGRADE_LOG = 'xforge/upgrade-log.md';

/**
 * Where a CLI before this layout put the same three things.
 *
 * Read, never written. A project can be holding a staged upgrade when this version arrives — stage
 * on the old CLI, install this one, then complete or roll back — and refusing that project would
 * strand it between two Scaffolds with the merge already half done. So `complete` and `rollback`
 * look here when the new paths are empty, finish the job, and remove the old directories with it.
 * `stage` only ever writes the new layout, so nothing new is ever created in this shape.
 *
 * Removable once no supported version can still be mid-upgrade in it: 0.9.0.
 */
export const LEGACY_STAGED_DIRECTORY = (version: string): string => `xforge/scaffold-${version}`;
export const LEGACY_SNAPSHOT_ROOT = 'xforge/.rollback';
export const LEGACY_SNAPSHOT_DIRECTORY = (version: string): string => `${LEGACY_SNAPSHOT_ROOT}/scaffold-${version}`;
export const LEGACY_UPGRADE_STATE = `${LEGACY_SNAPSHOT_ROOT}/manifest.json`;

export interface RollbackManifest {
  fromVersion: string;
  toVersion: string;
  stagedAt: string;
  completedAt: string | null;
  gitHead: string | null;
  /**
   * Whether the managed trees were free of uncommitted work when this was staged.
   *
   * `gitHead` alone does not say what a rollback needs to know. A commit is only a restore point for
   * the files that were actually in it, so a HEAD recorded over a dirty working tree names a state
   * the project was never in — and offering it as a fallback would hand somebody a command that
   * silently discards whatever they had not committed. False here (or a null `gitHead`) means the
   * snapshot is the only route back, and `--rollback` says so instead of printing a git command that
   * cannot be trusted.
   */
  gitClean: boolean;
  /** Digests of the managed trees as they stood before staging — what a rollback restores to. */
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


