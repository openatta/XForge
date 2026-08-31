/**
 * The one table that says which files XForge owns, and in what sense.
 *
 * That question used to be answered in four places that could not see each other: `MANAGED_PREFIXES`
 * in `core/upgrade.ts` (what an upgrade stages, diffs, snapshots and restores), `spec.match.paths`
 * of the `protected-files` PermissionPolicy (what an Agent's write is refused), `spec.scope.paths`
 * of the `governance-assets-are-integrator-only` Rule (what an Agent is told the boundary is), and a
 * hardcoded "## Never" list in the merge prompt. Four lists maintained by hand drift, and they did.
 * `xforge/flows/` was denied to Agents and named in the Rule for a long time while the upgrade
 * transaction did not know the directory existed, so every project ran the Flow it was initialised
 * with for as long as it existed and the upgrade log reported "every file the plan named now
 * matches" of a plan that could not name one. `xforge/scripts/` is in exactly that position today:
 * `core/resource-loader.ts` loads `xforge/scripts/<id>/script.yaml` as a first-class resource, the
 * payload ships one, `init` seeds it, and no upgrade has ever reached it.
 *
 * The payload yaml keeps its own copy of the deny and ask lists, because a PermissionPolicy has to
 * be a file the host can read without running the CLI. What changes is that the copy is no longer
 * the source: `test/unit/ownership-zones.test.ts` compares it against this table and goes red when
 * they diverge, which is what the "keep in exact 1:1 alignment" comments in those files were asking
 * for and had no way to obtain.
 *
 * A path carries several independent facts here, and they are deliberately not collapsed into one
 * flag. Every collapse produces a wrong answer for some real path: `xforge/changes/` is a tree an
 * upgrade must never read or write and also a tree the lifecycle Skills write to constantly, and
 * `xforge/scaffold/` is the most managed tree there is and also one an Agent may freely author in.
 * "Who owns it", "may an Agent write it", and "does it travel with the upgrade transaction" are
 * three questions, and a single boolean can only answer one of them.
 */

/** The sentinel that tells every other command an upgrade is staged and half-finished. */
export const UPGRADE_SENTINEL = 'xforge/UPGRADING.md';

/** Everything an in-flight upgrade puts on disk, including the restore point. */
export const UPGRADE_ROOT = 'xforge/.upgrade/';

export type ZoneId = 'managed-source' | 'project-owned' | 'derived' | 'record' | 'transient';

/**
 * What a PermissionPolicy does with an Agent's write to this path.
 *
 * 'deny' = a PermissionPolicy refuses the Agent's write outright.
 * 'ask'  = it requires a human confirmation instead.
 * 'open' = deliberately unguarded; a Skill legitimately authors here.
 */
export type AgentWrite = 'deny' | 'ask' | 'open';

export interface ZoneEntry {
  /** Project-relative. A `prefix` carries its trailing slash; a `file` is the exact path. */
  path: string;
  kind: 'prefix' | 'file';
  agentWrite: AgentWrite;
}

export interface OwnershipZone {
  id: ZoneId;
  entries: readonly ZoneEntry[];
  /**
   * 'full' = snapshotted and restored by an upgrade. 'pin-only' = only the version pin fields travel
   * with the transaction. 'none' = never in it.
   */
  inTransaction: 'full' | 'pin-only' | 'none';
  /**
   * True when the file is a pure function of sources and can be reproduced by reprojecting instead
   * of being snapshotted.
   */
  regenerable: boolean;
  /** True for the governance record: an upgrade never reads or writes it, in either direction. */
  neverTouch: boolean;
}

/**
 * How an entry is spelled in a PermissionPolicy or a Rule scope.
 *
 * The payload yaml matches on globs, this table stores prefixes, and the two forms are not
 * interchangeable: `xforge/specs/` matches nothing as a glob and `xforge/specs/**` is not a prefix
 * `String.startsWith` can use. Rendering in one place is what keeps a comparison between the table
 * and the yaml a comparison of the same alphabet rather than a near-miss nobody notices.
 */
export const policyGlob = (entry: ZoneEntry): string =>
  entry.kind === 'prefix' ? `${entry.path}**` : entry.path;

export const OWNERSHIP_ZONES: readonly OwnershipZone[] = [
  {
    /*
     * Files the CLI ships and an upgrade proposes newer versions of. This is the whole of what a
     * `upgrade-scaffold` transaction stages, diffs and can roll back to.
     *
     * The three entries do not agree on `agentWrite`, and that is the point of separating the two
     * questions. `xforge/scaffold/` is `open` because the `xforge-scaffold` Skill legitimately
     * authors Skills, Rules, Gates and Policies there — denying it would deny the only way the job
     * gets done, which is the mistake `protected-manifest` was split out to undo elsewhere.
     * `xforge/flows/` sits in the same zone and is `deny` anyway: a Flow states how many approvals a
     * Stage needs, who may give them, and where a blocker sends the work back, and no Skill authors
     * one. An Agent that edits a Flow has lowered the bar its own work has to clear.
     * `xforge/scripts/` is `open` for the same reason as `xforge/scaffold/`: a Script is a resource
     * a Skill installs, and its Hook binding — not the file — is what governs when it runs.
     */
    id: 'managed-source',
    entries: [
      { path: 'xforge/scaffold/', kind: 'prefix', agentWrite: 'open' },
      { path: 'xforge/flows/', kind: 'prefix', agentWrite: 'deny' },
      { path: 'xforge/scripts/', kind: 'prefix', agentWrite: 'open' },
    ],
    inTransaction: 'full',
    regenerable: false,
    neverTouch: false,
  },
  {
    /*
     * Files a project writes for itself. An upgrade walks the version pin inside the Manifest and
     * touches nothing else here: overwriting a project's Constitution with the payload's would
     * replace the principles a person chose with the ones the package happened to ship, and there is
     * no base to merge against that could tell the two apart.
     *
     * The Manifest is `ask` rather than `deny` because `xforge-scaffold` must edit
     * `scaffold.skills`/`rules`/`gates` to select a resource and no CLI command does it — a deny
     * there refuses the only path to the job. The Constitution is `deny` because it is the document
     * every Gate measures work against, so an Agent that may edit it may edit its own passing
     * criteria. `architecture.md` and `XFORGE.md` are `open`: `xforge-architect` writes the first and
     * the second is the projected entry point Agents are expected to keep current.
     */
    id: 'project-owned',
    entries: [
      { path: 'xforge/manifest.yaml', kind: 'file', agentWrite: 'ask' },
      { path: 'xforge/constitution.md', kind: 'file', agentWrite: 'deny' },
      { path: 'xforge/architecture.md', kind: 'file', agentWrite: 'open' },
      { path: 'xforge/XFORGE.md', kind: 'file', agentWrite: 'open' },
    ],
    inTransaction: 'pin-only',
    regenerable: false,
    neverTouch: false,
  },
  {
    /*
     * Outputs, not inputs. Both are a pure function of the sources above, so an upgrade neither
     * snapshots nor restores them — `xforge install` reprojects them afterwards and a stale copy
     * carried through the transaction would only be a slower way of reaching the same bytes, or a
     * wrong one if the merge changed a source.
     *
     * `lock.yaml` is `deny` because it records the digest of every projected file: an Agent that can
     * write it can make a drifted projection look reconciled, which is precisely the drift `doctor`
     * exists to find. `.state.json` is `open` because it is a cache with no authority — nothing
     * trusts it, and it is rebuilt from the record whenever it disagrees.
     */
    id: 'derived',
    entries: [
      { path: 'xforge/lock.yaml', kind: 'file', agentWrite: 'deny' },
      { path: 'xforge/.state.json', kind: 'file', agentWrite: 'open' },
    ],
    inTransaction: 'none',
    regenerable: true,
    neverTouch: false,
  },
  {
    /*
     * What actually happened: Changes, the canonical Specs they merged into, and the audit chain.
     * `neverTouch` is the strongest statement in this table — an upgrade does not snapshot it, does
     * not restore it, and does not read it. Rolling a Scaffold back to an older release must not roll
     * the project's history back with it, and a snapshot that contained approvals would let exactly
     * that happen.
     *
     * `changes/` being `open` inside a `neverTouch` zone is not a contradiction, it is the two
     * questions coming apart. `neverTouch` is about the upgrade transaction; `agentWrite` is about an
     * Agent's tool call. The lifecycle Skills write Change content all day through governed Changes,
     * and none of that gives an upgrade any business restoring an older copy of it. `specs/` is
     * `deny` because a canonical Spec changes only by a merged delta, and `.audit/` because a
     * hash-chained ledger an Agent can write is a ledger that proves nothing.
     *
     * `contracts/` is here for the same reason as `specs/`, one level out: a Spec records what the
     * product must do and a contract records what one module promises another, and both change only
     * by a delta that was reviewed and merged. Writing the baseline directly is worse than writing a
     * Spec directly, because the other modules are already building against it -- a Worker that
     * edits an interface leaves every parallel package implementing something nothing agreed to, and
     * the packages find out at integration.
     *
     * `neverTouch` is the half that is easy to get wrong here. Rolling a Scaffold back to an older
     * release must not roll back what this project's modules promise each other: the CLI's version
     * and the project's interface history are unrelated facts, and a snapshot holding the second
     * would let a rollback quietly restore an interface two Changes ago.
     */
    id: 'record',
    entries: [
      { path: 'xforge/changes/', kind: 'prefix', agentWrite: 'open' },
      { path: 'xforge/specs/', kind: 'prefix', agentWrite: 'deny' },
      { path: 'xforge/contracts/', kind: 'prefix', agentWrite: 'deny' },
      { path: 'xforge/.audit/', kind: 'prefix', agentWrite: 'deny' },
    ],
    inTransaction: 'none',
    regenerable: false,
    neverTouch: true,
  },
  {
    /*
     * The upgrade's own working state. Neither path exists yet — a later step of this work
     * introduces them — and they are declared here now on purpose, because both are load-bearing the
     * moment they appear and an Agent overwriting either is a real failure mode rather than a
     * hypothetical one. The snapshot is the restore point, so an Agent that writes into it destroys
     * the only copy of what the project looked like before the merge, and the rollback that was
     * supposed to be safe silently restores the merge instead. The sentinel is what tells every
     * other command that an upgrade is half-finished, so an Agent that deletes it to make a check
     * pass has told the whole CLI the transaction finished when it did not.
     *
     * Nothing here survives a completed or rolled-back upgrade, which is why the zone is out of the
     * transaction rather than in it: it *is* the transaction.
     */
    id: 'transient',
    entries: [
      { path: `${UPGRADE_ROOT}snapshot/`, kind: 'prefix', agentWrite: 'deny' },
      { path: UPGRADE_SENTINEL, kind: 'file', agentWrite: 'deny' },
      /*
       * The rest of the working state: the staged release under `incoming/`, and the plan documents
       * beside it. `open` rather than `deny`, and claimed rather than left unowned.
       *
       * Unowned was the wrong answer. Without this entry `zoneFor` reports `xforge/.upgrade/incoming/…`
       * as a path XForge does not claim -- the same answer it gives for `src/index.ts` -- which is
       * false about the one directory this command created. Denied would be the wrong answer too:
       * `incoming/` is what the merging Agent reads, and a policy that stopped writes there would
       * stop nothing worth stopping while making the merge look forbidden.
       */
      { path: UPGRADE_ROOT, kind: 'prefix', agentWrite: 'open' },
    ],
    inTransaction: 'none',
    regenerable: false,
    neverTouch: false,
  },
];

/**
 * The zone a project-relative path belongs to, or null for a path XForge does not claim.
 *
 * Longest match, not first match. `xforge/.upgrade/snapshot/` and `xforge/scaffold/` are both
 * prefixes and a snapshot holds a copy of the Scaffold, so the order entries happen to be declared
 * in must not decide which zone a path under both is read as. Longest wins for the same reason a
 * router prefers the more specific route: the more specific entry is the one that was written about
 * this path rather than about the tree it sits in.
 */
export function zoneFor(relative: string): OwnershipZone | null {
  let best: OwnershipZone | null = null;
  let bestLength = -1;
  for (const zone of OWNERSHIP_ZONES) {
    for (const entry of zone.entries) {
      const matches = entry.kind === 'prefix' ? relative.startsWith(entry.path) : relative === entry.path;
      if (!matches || entry.path.length <= bestLength) continue;
      best = zone;
      bestLength = entry.path.length;
    }
  }
  return best;
}

function globsWhere(predicate: (entry: ZoneEntry, zone: OwnershipZone) => boolean): string[] {
  /* A Set, because an entry can qualify on two grounds at once -- `xforge/specs/` is both `deny` and
     inside the `neverTouch` zone -- and a duplicated glob in a policy is a second rule that can be
     edited out of step with the first. */
  const globs = new Set<string>();
  for (const zone of OWNERSHIP_ZONES) {
    for (const entry of zone.entries) {
      if (predicate(entry, zone)) globs.add(policyGlob(entry));
    }
  }
  return [...globs];
}

/**
 * Every tree an upgrade stages, diffs, snapshots and restores. This is what `MANAGED_PREFIXES` reads
 * from, so a tree added to the `managed-source` zone is managed by the transaction from that moment
 * rather than from whenever somebody remembers the second list.
 */
export const transactionPrefixes: readonly string[] = OWNERSHIP_ZONES
  .filter((zone) => zone.inTransaction === 'full')
  .flatMap((zone) => zone.entries.filter((entry) => entry.kind === 'prefix').map((entry) => entry.path));

/** The `protected-files` PermissionPolicy's deny list. */
export const guardedPaths: readonly string[] = globsWhere((entry) => entry.agentWrite === 'deny');

/** The `protected-manifest` PermissionPolicy's ask list. */
export const askPaths: readonly string[] = globsWhere((entry) => entry.agentWrite === 'ask');

/**
 * What the merge prompt's "## Never" list names.
 *
 * Read off the one thing an upgrade merge is for: it writes the trees the transaction carries, and
 * nothing else. So the list is every path outside `inTransaction: 'full'` — which is wider than
 * `guardedPaths` on purpose, because a denied path is a path an Agent is *stopped* at and several of
 * these are places an Agent is not stopped. `xforge/changes/` is `open`, since the lifecycle Skills
 * belong there; `xforge/architecture.md` is `open`, since `xforge-architect` writes it. Neither is
 * any business of a Scaffold merge, and telling the merging Agent only the denied paths would leave
 * the Change history and the architecture record looking like fair game.
 *
 * Two exclusions, each because a narrower rule already covers the path and "never" would misstate
 * it:
 *
 * - `ask` entries. `xforge/manifest.yaml` is not never-touched; it is touched only to record a
 *   selection a person approved, which is what the prompt says about it in its own words.
 * - `xforge/.upgrade/incoming/`. It is the merge's *input*. Never writing there is true and never
 *   reading there is false, and a "Never" list is read as both.
 */
export const neverTouchPaths: readonly string[] = globsWhere(
  (entry, zone) => zone.inTransaction !== 'full'
    && entry.agentWrite !== 'ask'
    && entry.path !== UPGRADE_ROOT,
);
