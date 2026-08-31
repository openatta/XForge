import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { assertManaged, loadProject, writeScaffoldVersion } from '../core/project-loader.js';
import { executeProjection } from './projection.js';
import { installedTargets, readOwnership } from '../install/ownership.js';
import { safeResolve } from '../core/path-safety.js';
import { loadBundledScaffold } from '../core/bundled-scaffold.js';
import {
  LEGACY_SNAPSHOT_DIRECTORY, LEGACY_SNAPSHOT_ROOT, LEGACY_STAGED_DIRECTORY, LEGACY_UPGRADE_STATE,
  MANAGED_PREFIXES, MANAGED_ROOT, SNAPSHOT_DIRECTORY, STAGED_DIRECTORY, UPGRADE_DIRECTORY, UPGRADE_LOG, UPGRADE_STATE,
  adoptionReport, buildUpgradePlan, digestMap, driftedPaths, isManagedPath,
  type RollbackManifest, type UpgradePlan,
} from '../core/upgrade.js';
import { UPGRADE_SENTINEL, neverTouchPaths } from '../core/ownership-zones.js';
import type { StagedUpgrade } from '../core/upgrade-sentinel.js';

/**
 * Bringing an existing project onto the Scaffold the installed CLI ships.
 *
 * The upgrade never merges. It stages the incoming Scaffold beside the current one, snapshots what
 * is there now, and hands out a classification — and a person or an Agent does the merging. That
 * split is not timidity about writing files; it is where the line between computable and judgeable
 * actually falls. Which files differ is arithmetic. Whether a project's own wording in a Skill
 * should give way to a newer default is a question about that project's intent, and a tool that
 * answered it would be overwriting the adaptations the Scaffold exists to invite.
 *
 * Three moments, because a merge done by someone else needs all three to be safe:
 *
 * - **stage** copies the incoming Scaffold to `xforge/.upgrade/incoming/`, snapshots the project's
 *   own trees beside it, and writes `xforge/UPGRADING.md`. The marker is the visible half: an
 *   unfinished upgrade has to be obvious to somebody who did not start it, and it says so in a
 *   sentence that `doctor`, `state`, `check` and `transition` all repeat — where the old visible
 *   staging directory said it only to whoever happened to run `ls`.
 * - **complete** deletes the working state, records what the managed trees became — the only moment
 *   at which a post-merge baseline exists — and reprojects every target from the merged Scaffold.
 * - **rollback** restores the single snapshot and reprojects from it, and refuses when work has
 *   happened since — without the baseline `complete` records, it could not tell.
 */

type UpgradeMode = 'stage' | 'complete' | 'rollback';

interface UpgradeOptions {
  mode: UpgradeMode;
  dryRun?: boolean;
  force?: boolean;
  withActiveChanges?: boolean;
  allowDirty?: boolean;
}

interface UpgradeResult {
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
  changes: FileChange[];
}

/** Reads a directory subtree into project-relative paths, or an empty map when it does not exist. */
async function readTree(root: string, relative: string, keyPrefix: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const base = path.join(root, ...relative.split('/'));
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(absolute, `${key}/`);
      else if (entry.isFile()) files.set(key, await readFile(absolute));
    }
  };
  await walk(base, keyPrefix);
  return files;
}

/**
 * Every managed tree the project currently has, keyed by its project-relative path.
 *
 * Which trees those are is `ownership-zones.ts`'s answer, not this function's. It read `xforge/scaffold/`
 * alone for a long time, so a Flow was never brought, diffed, or mentioned -- and the upgrade log's
 * "every file the plan named now matches" was true of a plan that could not name it. `xforge/scripts/`
 * was in the same position until the zone table made the set one thing to edit rather than four.
 */
async function currentManaged(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const prefix of MANAGED_PREFIXES) {
    const relative = prefix.slice(0, -1);
    for (const [key, content] of await readTree(root, relative, prefix)) files.set(key, content);
  }
  return files;
}

function incomingManaged(files: Map<string, Buffer>): Map<string, Buffer> {
  return new Map([...files.entries()].filter(([relative]) => isManagedPath(relative)));
}

function gitHead(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Exactly the paths a rollback writes, which is what makes a commit usable as a restore point.
 *
 * The managed trees because they are restored wholesale, and the Manifest because the version pin
 * is walked backwards with them. Nothing else: `xforge/changes/` and the audit chain are the
 * project's record, an upgrade never touches them, and demanding they be committed would refuse an
 * upgrade over work that has nothing to do with it.
 */
const backstopPaths = (): string[] => [...MANAGED_PREFIXES.map((prefix) => prefix.slice(0, -1)), 'xforge/manifest.yaml'];

/**
 * Uncommitted work under those paths, or `null` when this is not a Git working tree.
 *
 * `null` and `[]` are deliberately different answers. An empty list means Git looked and found the
 * paths clean, so the recorded HEAD is a real restore point; `null` means there is nothing to ask,
 * and the snapshot is the whole of the safety net. Collapsing the two would let a project with no
 * repository at all report itself as having a backstop it does not have.
 */
function dirtyManagedPaths(root: string): string[] | null {
  const result = spawnSync('git', ['status', '--porcelain', '--', ...backstopPaths()], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  return result.stdout.split('\n').filter(Boolean).map(porcelainPath).sort();
}

/**
 * The path out of one `git status --porcelain` line.
 *
 * Two shapes that dropping the first three characters gets wrong, and both end up in a refusal that
 * tells somebody which files to commit -- so a name that is not a real file is the whole cost.
 * A rename renders as `R  old -> new`, where the file that needs committing is the second half; and
 * a path git considers unusual is C-quoted, `"xforge/scaffold/gates/\303\251.yaml"`, which is a
 * name no shell completion will find.
 */
function porcelainPath(line: string): string {
  const rest = line.slice(3);
  const renamed = rest.indexOf(' -> ');
  const one = renamed === -1 ? rest : rest.slice(renamed + ' -> '.length);
  const trimmed = one.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  /* Git quotes with C escapes, and the octal ones are UTF-8 bytes rather than code points, so they
     are collected as bytes and decoded once at the end. */
  const bytes: number[] = [];
  const body = trimmed.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '\\') { bytes.push(...Buffer.from(body[index]!, 'utf8')); continue; }
    const next = body[++index];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      bytes.push(parseInt(body.slice(index, index + 3), 8));
      index += 2;
      continue;
    }
    const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
    bytes.push(...Buffer.from(escapes[next] ?? next, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The backstop paths that commit actually holds.
 *
 * `git restore` aborts on the first pathspec that matches nothing and restores *nothing* -- so
 * naming all four unconditionally produced a recovery command that failed outright on every project
 * predating `xforge/scripts/` being managed, which is precisely the population an upgrade to this
 * release finds. Offering a command that cannot run is worse than offering none, because it is read
 * as the route back right up until it is needed.
 */
function trackedAt(root: string, head: string, candidates: string[]): string[] {
  const result = spawnSync('git', ['ls-tree', '-r', '--name-only', head, '--', ...candidates], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return [];
  const tracked = result.stdout.split('\n').filter(Boolean);
  return candidates.filter((candidate) =>
    tracked.some((file) => file === candidate || file.startsWith(`${candidate}/`)));
}

/**
 * Changes that have not been archived.
 *
 * A Change's transition receipts record which Gates ran and bind to the Flow it was walking.
 * Replacing those definitions underneath it does not corrupt the history — the receipts remain a
 * true record of what happened — but the Change's remaining Stages would then run under rules its
 * Design never considered. That is a decision about the work, so it stops and names them.
 */
async function activeChanges(project: ProjectContext): Promise<string[]> {
  try {
    const absolute = await safeResolve(project.root, project.changesPath);
    return (await readdir(absolute, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
}

/** One upgrade in flight: what was recorded, and where the two directories holding it actually are. */
interface StagedState {
  record: RollbackManifest;
  /** Where to write the record back — the file it was read from, so a legacy upgrade closes in place. */
  statePath: string;
  staged: string;
  snapshot: string;
  legacy: boolean;
}

async function readJsonRecord(root: string, relative: string): Promise<RollbackManifest | null> {
  try { return JSON.parse(await readFile(path.join(root, ...relative.split('/')), 'utf8')) as RollbackManifest; }
  catch { return null; }
}

/**
 * The open upgrade, in whichever layout it was staged in.
 *
 * New paths first, then the pre-`.upgrade/` ones. A project can be holding a staged upgrade when
 * this version of the CLI arrives — staged on the old one, then installed over — and the merge may
 * already be half done. Refusing it would leave somebody between two Scaffolds with no command that
 * finishes the job, which is a worse answer than reading two shapes for one release. `stage` writes
 * only the new layout, so nothing keeps the old one alive.
 */
async function readStagedState(root: string): Promise<StagedState | null> {
  const current = await readJsonRecord(root, UPGRADE_STATE);
  if (current) {
    return { record: current, statePath: UPGRADE_STATE, staged: STAGED_DIRECTORY, snapshot: SNAPSHOT_DIRECTORY, legacy: false };
  }
  const legacy = await readJsonRecord(root, LEGACY_UPGRADE_STATE);
  if (legacy) {
    return {
      record: legacy,
      statePath: LEGACY_UPGRADE_STATE,
      staged: LEGACY_STAGED_DIRECTORY(legacy.toVersion),
      snapshot: LEGACY_SNAPSHOT_DIRECTORY(legacy.fromVersion),
      legacy: true,
    };
  }
  return null;
}

/**
 * The marker that says an upgrade is open, in a place a person and every other command will see.
 *
 * `core/upgrade-sentinel.ts` reads it; the contract between the two is that the version span is
 * found by label rather than by position, so the prose around these lines is free to change. The
 * commands are named here for a reader, and read out of this file by nothing — a marker sitting in
 * a tree an Agent is mid-merge in should not be able to tell anyone which command to run.
 */
function sentinelText(span: StagedUpgrade, toVersion: string): string {
  const from = span.fromVersion ?? 'unknown';
  return [
    '# Scaffold upgrade in progress',
    '',
    `- From: ${from}`,
    `- To: ${span.toVersion ?? toVersion}`,
    '',
    `The incoming Scaffold is staged at \`${STAGED_DIRECTORY}/\`, laid out the way it merges, and`,
    `\`${SNAPSHOT_DIRECTORY}/\` holds the project's own copy as it stood before. Do not edit the`,
    'snapshot: it is the restore point.',
    '',
    'Read `' + `${UPGRADE_DIRECTORY}/MERGE.md` + '` and merge, then run `xforge upgrade-scaffold --complete`.',
    'To abandon the merge and restore the previous Scaffold, run `xforge upgrade-scaffold --rollback`.',
    '',
    'This file is written when an upgrade is staged and removed when either of those commands closes',
    'it, so while it exists `doctor`, `state`, `check` and `transition` will say an upgrade is open.',
    '',
  ].join('\n');
}

/**
 * Replaying the projection, which is what turns a restore into a finished one.
 *
 * `--rollback` used to put the Scaffold sources back and then print "Run `xforge install`". That
 * left the project in a state nobody had asked for and no command would notice: sources at the old
 * version, `.claude/` and every other target still rendered from the new one, and `lock.yaml`
 * recording the digests of files that were no longer on disk. The instruction was correct and easy
 * to miss, and missing it produced a `doctor` failure three commands after its cause. `--complete`
 * had the same gap from the other direction.
 *
 * The projection is not snapshotted, for the same reason it can be replayed: every file it writes
 * is a function of the Scaffold sources, the Manifest and the adapter version, so restoring the
 * inputs and rendering again arrives at the same bytes that saving the outputs would have. Saving
 * them would also put two records of one installation on disk — the snapshot and `.state.json` —
 * and leave nothing to say which of them was right.
 *
 * `update` rather than `install` on purpose. A project that was never installed has no projection
 * to restore and `install` would create one, which is an installation invented on the way out of an
 * upgrade. That case is answered here rather than by `update`'s refusal, though: `update` says
 * XFORGE_NOT_INSTALLED, which is a true sentence about a project and a wrong one about this command
 * — there being no projection to replay is the reason to do nothing, not a reason to fail a merge
 * that has already been adopted on disk.
 */
async function reproject(project: ProjectContext): Promise<{ diagnostics: Diagnostic[]; changes: FileChange[]; applied: boolean }> {
  /*
   * Re-read first. `writeScaffoldVersion` has just rewritten the Manifest, and the merge — or the
   * restore — rewrote the resources this context was loaded with, so projecting from `project`
   * would render from content that is no longer on disk and then lock the digests of it. `update`
   * re-reads after its own migration for exactly this reason.
   */
  const reloaded = await loadProject(project.root, { exactRoot: true });
  /* Nothing was ever projected, so there is nothing to replay and nothing failed to replay. */
  if (installedTargets(await readOwnership(reloaded)).length === 0) return { diagnostics: [], changes: [], applied: true };
  const result = await executeProjection(reloaded, 'update', { dryRun: false });
  /*
   * `executeProjection` skips the write entirely when any diagnostic is an error, and still returns
   * the plan it would have applied. Splicing those `changes` in and saying "reprojected" regardless
   * put files in the envelope as created that were never written, under a sentence claiming a
   * reprojection that did not happen — the two things a caller reads to decide whether to trust the
   * state on disk.
   */
  const applied = !result.diagnostics.some((item) => item.severity === 'error');
  return { diagnostics: result.diagnostics, changes: applied ? result.changes : [], applied };
}

export async function executeUpgrade(project: ProjectContext, options: UpgradeOptions): Promise<UpgradeResult> {
  assertManaged(project, `upgrade-scaffold${options.mode === 'stage' ? '' : ` --${options.mode}`}`);
  if (options.mode === 'stage') return stage(project, options);
  if (options.mode === 'complete') return complete(project, options);
  return rollback(project, options);
}

async function stage(project: ProjectContext, options: UpgradeOptions): Promise<UpgradeResult> {
  const bundle = await loadBundledScaffold();
  const fromVersion = String(project.manifest.scaffold?.source?.version ?? 'unknown');
  const toVersion = bundle.version;
  const staged = STAGED_DIRECTORY;
  const diagnostics: Diagnostic[] = [];

  /*
   * Asked of the record rather than of one directory, because the directory is the thing that moved.
   *
   * Reading `xforge/.upgrade/incoming/` alone answered "no upgrade in progress" for a project holding
   * one staged by an older CLI -- the exact case `readStagedState` exists to serve. Staging then ran,
   * and the first thing it does is clear the snapshot root: the pre-upgrade copy and the record
   * naming it were deleted, and the replacement snapshot was taken of half-merged trees. Exit 0, no
   * diagnostic, and the only route back gone.
   */
  const inFlight = await readStagedState(project.root);
  if (inFlight && !inFlight.record.completedAt) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_ALREADY_STAGED',
      `An upgrade to ${inFlight.record.toVersion} is already in progress, staged at ${inFlight.staged}. Finish the merge and run \`xforge upgrade-scaffold --complete\`, or \`xforge upgrade-scaffold --rollback\` to abandon it.`,
      inFlight.staged,
    ));
  }

  const active = await activeChanges(project);
  if (active.length > 0 && !options.withActiveChanges) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_ACTIVE_CHANGES',
      `${active.length} Change(s) are still open: ${active.join(', ')}. Their remaining Stages would run under Gates and Skills their Design never saw. Archive them first, or pass --with-active-changes to accept that.`,
      project.changesPath,
    ));
  }
  if (active.length > 0) {
    diagnostics.push(diagnostic(
      'XFORGE_UPGRADE_ACTIVE_CHANGES_ACCEPTED',
      `Upgrading with ${active.length} open Change(s): ${active.join(', ')}. Each one continues under the merged Scaffold, not the one it started on.`,
      project.changesPath,
      'warning',
    ));
  }

  /*
   * A commit before the merge, so there is something to fall back to.
   *
   * The snapshot below is the primary route back and it does not need Git to work. This is the
   * backstop underneath it: the one failure the snapshot cannot survive is somebody deleting or
   * editing it, and a commit is the copy that lives somewhere else. It is only worth anything if it
   * holds the pre-upgrade state, which is why a dirty tree refuses rather than warning — recording
   * a HEAD over uncommitted work would name a state the project was never in, and a fallback that
   * quietly discards whatever was not committed is worse than no fallback at all.
   */
  const dirty = dirtyManagedPaths(project.root);
  const gitClean = dirty !== null && dirty.length === 0;
  if (dirty !== null && dirty.length > 0 && !options.allowDirty) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_UNCOMMITTED',
      `${dirty.length} managed file(s) have uncommitted changes: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}. Commit them first so this upgrade has a restore point outside its own snapshot, or pass --allow-dirty to stage without one.`,
      'xforge',
    ));
  }
  if (dirty !== null && dirty.length > 0) {
    diagnostics.push(diagnostic(
      'XFORGE_UPGRADE_UNCOMMITTED_ACCEPTED',
      `Staging over ${dirty.length} uncommitted managed file(s). The snapshot at ${SNAPSHOT_DIRECTORY} is the only way back — there is no commit holding the pre-upgrade state.`,
      'xforge',
      'warning',
    ));
  }

  const current = await currentManaged(project.root);
  const incoming = incomingManaged(bundle.files);
  const plan = buildUpgradePlan({ fromVersion, toVersion, manifest: project.manifest, current, incoming });
  /*
   * The Manifest says the Scaffold is already this version, and the files say otherwise.
   *
   * Reachable in one specific way: a project that ran `xforge update` on a CLI released before the
   * pins were separated, where `update` wrote the new version into `scaffold.version` without any
   * Scaffold file changing. Nothing here can recover the version those files actually came from, so
   * the honest move is to say the span is unknown rather than print "X -> X" over a real upgrade and
   * name the rollback snapshot after the version being left for.
   */
  const differing = plan.counts.changed + plan.counts.added;
  if (fromVersion === toVersion && differing > 0) {
    diagnostics.push(diagnostic(
      'XFORGE_UPGRADE_VERSION_PIN_UNRELIABLE',
      `The Manifest pins the Scaffold at ${fromVersion}, the same version being installed, yet ${differing} file(s) differ from it. The pin was written by an older \`xforge update\`, which advanced it without changing any Scaffold file, so the real starting version is not recorded anywhere and this upgrade's span cannot be reported. The merge itself is unaffected — it is computed from file content, not from the pin.`,
      'xforge/manifest.yaml',
      'warning',
    ));
  }

  if (options.dryRun) {
    return { data: { mode: 'stage', dryRun: true, plan, staged, rollback: SNAPSHOT_DIRECTORY, gitClean }, diagnostics, changes: [] };
  }

  const changes: FileChange[] = [];
  /* The snapshot is written before anything else: it is the only thing that makes the rest undoable. */
  const snapshot = SNAPSHOT_DIRECTORY;
  await rm(path.join(project.root, ...UPGRADE_DIRECTORY.split('/')), { recursive: true, force: true });
  /* And the pre-`.upgrade/` root, if a legacy upgrade closed here and left its record behind. Exactly
     one snapshot is kept, and two of them in two shapes is one more than that. */
  await rm(path.join(project.root, ...LEGACY_SNAPSHOT_ROOT.split('/')), { recursive: true, force: true });
  for (const [relative, content] of current) {
    const target = path.posix.join(snapshot, relative.slice(MANAGED_ROOT.length));
    await atomicWrite(project.root, target, content);
  }
  const manifestRecord: RollbackManifest = {
    fromVersion, toVersion, stagedAt: new Date().toISOString(), completedAt: null,
    gitHead: gitHead(project.root), gitClean, before: digestMap(current), after: null,
  };
  await atomicWrite(project.root, UPGRADE_STATE, `${JSON.stringify(manifestRecord, null, 2)}\n`);
  changes.push({ action: 'create', path: snapshot, source: `snapshot:${fromVersion}` });

  for (const [relative, content] of incoming) {
    const target = path.posix.join(staged, relative.slice(MANAGED_ROOT.length));
    await atomicWrite(project.root, target, content);
    changes.push({ action: 'create', path: target, digest: sha256(content), source: `npm:${bundle.package}@${toVersion}:scaffold` });
  }

  for (const [name, content] of Object.entries(stagedDocuments(plan, staged, snapshot))) {
    await atomicWrite(project.root, path.posix.join(UPGRADE_DIRECTORY, name), content);
    changes.push({ action: 'create', path: path.posix.join(UPGRADE_DIRECTORY, name), digest: sha256(content) });
  }

  /*
   * The working state does not belong in the history. The snapshot duplicates files the repository
   * already has at the commit this upgrade was staged from, and `incoming/` is a copy of a published
   * package -- committing either puts eighty files into a diff nobody reads, twice per upgrade. The
   * sentinel is deliberately not covered by this: it is the one file here a teammate who pulls the
   * branch needs to see.
   */
  const ignore = path.posix.join(UPGRADE_DIRECTORY, '.gitignore');
  await atomicWrite(project.root, ignore, '*\n!.gitignore\n');
  changes.push({ action: 'create', path: ignore });

  const span: StagedUpgrade = { fromVersion: fromVersion === 'unknown' ? null : fromVersion, toVersion };
  await atomicWrite(project.root, UPGRADE_SENTINEL, sentinelText(span, toVersion));
  changes.push({ action: 'create', path: UPGRADE_SENTINEL });

  return { data: { mode: 'stage', plan, staged, rollback: snapshot }, diagnostics, changes };
}

async function complete(project: ProjectContext, options: UpgradeOptions): Promise<UpgradeResult> {
  const state = await readStagedState(project.root);
  if (!state) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_NOT_STAGED',
      'No upgrade is in progress: there is no rollback snapshot to complete against. Run `xforge upgrade-scaffold` first.',
      UPGRADE_STATE,
    ));
  }
  const { record, staged } = state;
  const stagedFiles = await readTree(project.root, staged, MANAGED_ROOT);
  if (stagedFiles.size === 0 && record.completedAt) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_ALREADY_COMPLETE',
      `The upgrade to ${record.toVersion} was already completed at ${record.completedAt}.`,
      UPGRADE_STATE,
    ));
  }

  /* The plan sits beside the staged release rather than inside it, so `incoming/` holds the payload
     and nothing else. A legacy upgrade wrote it into the staged directory, which is the second
     lookup: without it a merge staged on the older CLI completes with an empty adoption report --
     silently, since an unreadable plan is indistinguishable from a plan that raised no files. */
  const planText = await readFile(path.join(project.root, ...UPGRADE_DIRECTORY.split('/'), 'plan.json'), 'utf8')
    .catch(() => readFile(path.join(project.root, ...staged.split('/'), 'plan.json'), 'utf8'))
    .catch(() => null);
  const merged = await currentManaged(project.root);
  const report = planText
    ? adoptionReport(JSON.parse(planText) as UpgradePlan, merged)
    : { considered: 0, matching: 0, notMatching: [] as string[] };

  if (options.dryRun) {
    return { data: { mode: 'complete', dryRun: true, staged, adoption: report, reprojects: true }, diagnostics: [], changes: [] };
  }

  const changes: FileChange[] = [];
  await rm(path.join(project.root, ...staged.split('/')), { recursive: true, force: true });
  changes.push({ action: 'delete', path: staged });

  /*
   * And the plan documents, which used to go with the staged directory because they lived inside it.
   * Moving them up to `xforge/.upgrade/` left them behind on `--complete`, and a stale `MERGE.md` is
   * not inert: the Skill's first instruction is to read it, so an Agent invoked after the upgrade
   * closed would follow a prompt describing a merge that already happened, pointing at an
   * `incoming/` that no longer exists. The snapshot, the record and the `.gitignore` stay -- the
   * rollback point outlives the merge on purpose.
   */
  for (const name of PLAN_DOCUMENTS) {
    const relative = path.posix.join(UPGRADE_DIRECTORY, name);
    await rm(path.join(project.root, ...relative.split('/')), { force: true });
    changes.push({ action: 'delete', path: relative });
  }

  /*
   * The merge is adopted, so now — and only now — the Manifest may say the Scaffold is this version.
   * `xforge update` deliberately no longer does this: it moves the CLI pin, because the CLI is what
   * it changed. Advancing the Scaffold pin here is what keeps `fromVersion` on the *next* upgrade
   * honest, since `stage()` reads it straight back out of `scaffold.source.version`.
   */
  changes.push(...await writeScaffoldVersion(project, record.toVersion, false));

  /* The merged Scaffold is only adopted once the targets are rendering from it. Until this runs,
     every Agent on the project is still reading the Skills the *previous* Scaffold projected. */
  const projected = await reproject(project);
  changes.push(...projected.changes);
  if (!projected.applied) {
    projected.diagnostics.push(diagnostic(
      'XFORGE_UPGRADE_REPROJECTION_SKIPPED',
      `The merge is recorded as complete, but the reprojection did not run — see the errors above — so every target still renders the ${record.fromVersion} Scaffold. Fix those, then run \`xforge install\`.`,
      'xforge/.state.json',
      'warning',
    ));
  }

  /*
   * Last, and only once nothing above can still throw. `reproject` reloads the project, so a Manifest
   * the merge left schema-invalid raises there -- and removing the marker before that point ended the
   * run with `completedAt` still null, no log entry, and every command that reads the marker now
   * silently reporting a project with no upgrade open at the moment one is stuck half-finished.
   */
  await rm(path.join(project.root, ...UPGRADE_SENTINEL.split('/')), { force: true });
  changes.push({ action: 'delete', path: UPGRADE_SENTINEL });

  const completedAt = new Date().toISOString();
  await atomicWrite(project.root, state.statePath, `${JSON.stringify({
    ...record, completedAt, after: digestMap(merged),
  } satisfies RollbackManifest, null, 2)}\n`);
  changes.push({ action: 'modify', path: state.statePath });

  await appendUpgradeLog(project.root, record, completedAt, report);
  changes.push({ action: 'modify', path: UPGRADE_LOG });

  return {
    data: { mode: 'complete', from: record.fromVersion, to: record.toVersion, completedAt, adoption: report },
    diagnostics: projected.diagnostics, changes,
  };
}

async function rollback(project: ProjectContext, options: UpgradeOptions): Promise<UpgradeResult> {
  const state = await readStagedState(project.root);
  if (!state) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_NO_ROLLBACK',
      'There is nothing to roll back to. Exactly one snapshot is kept, and it is taken when an upgrade is staged.',
      UPGRADE_STATE,
    ));
  }

  const { record, snapshot } = state;
  const diagnostics: Diagnostic[] = [];
  const current = await currentManaged(project.root);
  /*
   * Before the merge is complete there is no `after` baseline, so the comparison is against the
   * pre-upgrade state and any difference is the merge itself — which is exactly what abandoning an
   * upgrade means to discard. After completion, a difference is work done since, and discarding
   * that silently is the failure this refuses.
   */
  const drifted = record.after ? driftedPaths(record.after, digestMap(current)) : [];
  if (drifted.length > 0 && !options.force) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_ROLLBACK_DRIFT',
      `${drifted.length} Scaffold file(s) changed since the upgrade completed: ${drifted.slice(0, 5).join(', ')}${drifted.length > 5 ? ', …' : ''}. Rolling back would discard that work. Re-run with --force to do it anyway.`,
      'xforge/scaffold',
    ));
  }

  const saved = await readTree(project.root, snapshot, MANAGED_ROOT);
  if (saved.size === 0) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_ROLLBACK_MISSING',
      `The rollback snapshot at ${snapshot} is empty or missing, so ${record.fromVersion} cannot be restored.`,
      snapshot,
    ));
  }

  if (options.dryRun) {
    return { data: { mode: 'rollback', dryRun: true, to: record.fromVersion, files: saved.size, drifted, reprojects: true }, diagnostics: [], changes: [] };
  }

  const changes: FileChange[] = [];
  /*
   * Every managed tree is cleared before the snapshot is written back, and only the trees the
   * snapshot actually holds.
   *
   * Clearing matters because restoring is a write of the files that were saved, and a file the
   * merge *added* was never saved. Deleting only `xforge/scaffold/` left those survivors behind in
   * `xforge/flows/`, where a Flow the project never adopted is not inert: `loadFlows` reads every
   * `.yaml` in that directory rather than the Manifest's selection, and `flowEligibilityDiagnostics`
   * measures each Change against every Flow that declares `policy.requiredWhen`. An orphan could
   * demand a Flow of work that had rolled back to a Scaffold which never mentioned it.
   *
   * The `savedPrefixes` filter is the part that is not symmetry for its own sake. Snapshots written
   * before Flows were managed contain `xforge/scaffold/` alone, and a project can hold one: stage an
   * upgrade on the older CLI, install this one, roll back. Deleting a tree this snapshot cannot
   * restore would take the project's entire governance definition with nothing to put back, which is
   * a worse outcome than the leftover file this fix exists to prevent. So a tree the snapshot does
   * not cover is left exactly as it stands, and said out loud rather than passed over in silence.
   */
  const savedPrefixes = MANAGED_PREFIXES.filter((prefix) => [...saved.keys()].some((relative) => relative.startsWith(prefix)));
  for (const prefix of savedPrefixes) {
    await rm(path.join(project.root, ...prefix.slice(0, -1).split('/')), { recursive: true, force: true });
  }
  /*
   * "The snapshot cannot restore this tree" is only worth saying about a tree that is actually
   * there. A snapshot holds no files under a prefix for two quite different reasons — it was taken
   * by a CLI that did not manage that tree yet, or the project simply has none — and the second is
   * the common case: `xforge/scripts/` is optional, so warning on absence alone would hand a
   * scripts-free project this warning on every rollback it ever performs, about a directory it does
   * not have. What is left standing is what needs checking, so the project's own trees decide.
   */
  /*
   * A snapshot holding nothing under a prefix means one of two opposite things, and the record can
   * tell them apart where the directory listing cannot.
   *
   * If `before` recorded no files there either, the project simply had no such tree when this was
   * staged — so anything standing there now arrived in the merge, and removing it *is* the restore.
   * Leaving it was the bug: `loadFlows` reads every `.yaml` under `xforge/flows/` regardless of what
   * the Manifest selects, so a Flow brought in by an abandoned merge stays live after the rollback
   * that was supposed to discard it, and `flowEligibilityDiagnostics` can then demand it of work
   * that rolled back to a Scaffold which never mentioned it. That is the orphan the clearing step
   * above exists to prevent, arriving through the door the filter left open.
   *
   * A legacy record is the case where the two cannot be told apart. Its `before` was written by a
   * CLI that managed fewer trees, so an absent prefix there is silence rather than a statement, and
   * deleting on silence would take a tree the project had all along with nothing to put back. Those
   * are left standing and said out loud.
   */
  const uncovered = MANAGED_PREFIXES.filter((prefix) => !savedPrefixes.includes(prefix));
  const recorded = (prefix: string) => Object.keys(record.before).some((relative) => relative.startsWith(prefix));
  for (const prefix of uncovered) {
    const present = [...current.keys()].some((relative) => relative.startsWith(prefix));
    if (!state.legacy && !recorded(prefix)) {
      if (present) {
        await rm(path.join(project.root, ...prefix.slice(0, -1).split('/')), { recursive: true, force: true });
        changes.push({ action: 'delete', path: prefix.slice(0, -1) });
      }
      continue;
    }
    if (!present) continue;
    diagnostics.push(diagnostic(
      'XFORGE_UPGRADE_ROLLBACK_TREE_UNCOVERED',
      `The snapshot at ${snapshot} holds no files under ${prefix}, and it was taken by a CLI that managed fewer trees than this one does, so nothing here can say whether that tree is the project's own or the merge's. It was left exactly as it stands rather than restored or removed. Check ${prefix} against the ${record.fromVersion} release by hand.`,
      prefix.slice(0, -1),
      'warning',
    ));
  }
  for (const [relative, content] of saved) {
    await atomicWrite(project.root, relative, content);
    changes.push({ action: 'create', path: relative, digest: sha256(content) });
  }
  /* The files on disk are `fromVersion` again, so the Manifest says so again. A rollback after a
     completed upgrade is the one case where this walks the pin backwards; leaving it forward would
     leave the Manifest claiming the very version this command just discarded. */
  changes.push(...await writeScaffoldVersion(project, record.fromVersion, false));
  /* The staged directory, if the upgrade never completed, goes with it. */
  await rm(path.join(project.root, ...STAGED_DIRECTORY.split('/')), { recursive: true, force: true });
  await rm(path.join(project.root, ...LEGACY_STAGED_DIRECTORY(record.toVersion).split('/')), { recursive: true, force: true });
  await rm(path.join(project.root, ...UPGRADE_DIRECTORY.split('/')), { recursive: true, force: true });
  await rm(path.join(project.root, ...LEGACY_SNAPSHOT_ROOT.split('/')), { recursive: true, force: true });
  await rm(path.join(project.root, ...UPGRADE_SENTINEL.split('/')), { force: true });
  changes.push({ action: 'delete', path: UPGRADE_DIRECTORY });
  changes.push({ action: 'delete', path: UPGRADE_SENTINEL });

  /* Last, and only once the sources on disk are the ones being restored to: the projection is
     rendered from them, so running it any earlier would render the version being discarded. */
  const projected = await reproject(project);
  changes.push(...projected.changes);

  /* Only the paths that commit can actually restore, and only when the commit is a restore point at
     all. `trackedAt` returning nothing collapses to the same answer as a dirty stage: no backstop. */
  const backstop = record.gitClean && record.gitHead
    ? trackedAt(project.root, record.gitHead, backstopPaths())
    : [];

  return {
    data: { mode: 'rollback', to: record.fromVersion, restored: saved.size, forced: Boolean(options.force && drifted.length), reprojected: projected.applied },
    diagnostics: [...diagnostics, ...projected.diagnostics, diagnostic(
      'XFORGE_UPGRADE_ROLLED_BACK',
      projected.applied
        ? `Restored the ${record.fromVersion} Scaffold and reprojected every target from it. Run \`xforge doctor\`.`
        : `Restored the ${record.fromVersion} Scaffold. The reprojection did not run — see the errors above — so the targets still render the version that was just discarded. Fix those, then run \`xforge install\`.`,
      'xforge/scaffold', projected.applied ? 'info' : 'warning',
    ), ...(backstop.length > 0 ? [diagnostic(
      /* Printed, never run. Restoring from the snapshot has already happened by the time anyone
         reads this; the commit is what remains if that restore was itself wrong, and choosing to
         overwrite a working tree from Git is a decision that belongs to whoever is looking at it. */
      'XFORGE_UPGRADE_ROLLBACK_BACKSTOP',
      `The managed paths were committed at ${record.gitHead} before this upgrade was staged. If this restore is not what you wanted, \`git restore --source=${record.gitHead} -- ${backstop.join(' ')}\` puts them back as they were then.`,
      'xforge', 'info',
    )] : [])],
    changes,
  };
}

/**
 * The append-only history, kept apart from the rollback record on purpose.
 *
 * `xforge/.upgrade/state.json` is a mechanism: it holds one upgrade's digests and is replaced by
 * the next. This is the account of what happened, and it has to outlive both the staged directory
 * and every later upgrade, or a project ends up unable to say when it moved or what it decided.
 */
async function appendUpgradeLog(
  root: string,
  record: RollbackManifest,
  completedAt: string,
  report: { considered: number; matching: number; notMatching: string[] },
): Promise<void> {
  const file = path.join(root, ...UPGRADE_LOG.split('/'));
  const existing = await readFile(file, 'utf8').catch(() => '# Upgrade log\n\nOne entry per completed Scaffold upgrade, newest last.\n');
  const kept = report.notMatching.length === 0
    ? 'every file the plan named now matches the incoming Scaffold'
    : `${report.notMatching.length} of ${report.considered} kept the project's own version: ${report.notMatching.join(', ')}`;
  const entry = [
    ``,
    `## ${record.fromVersion} → ${record.toVersion}`,
    ``,
    `- Staged ${record.stagedAt}, completed ${completedAt}`,
    record.gitHead
      ? `- Git HEAD at staging: ${record.gitHead}${record.gitClean ? '' : ' (managed paths had uncommitted changes, so it is not a restore point)'}`
      : `- Not a Git working tree at staging`,
    `- Of ${report.considered} files the plan raised, ${kept}.`,
    ``,
  ].join('\n');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${existing.trimEnd()}\n${entry}`, 'utf8');
}

/** The three files `stage` writes beside the staged release, and `complete` takes away with it. */
const PLAN_DOCUMENTS = ['plan.json', 'plan.md', 'MERGE.md'] as const;

/** `plan.json`, its readable twin, and the prompt that hands the merge to an Agent. */
function stagedDocuments(plan: UpgradePlan, staged: string, snapshot: string): Record<string, string> {
  return {
    'plan.json': `${JSON.stringify(plan, null, 2)}\n`,
    'plan.md': renderPlanText(plan, staged, snapshot),
    'MERGE.md': renderMergePrompt(plan, staged, snapshot),
  };
}

function renderPlanText(plan: UpgradePlan, staged: string, snapshot: string): string {
  const byDisposition = (name: string) => plan.entries.filter((entry) => entry.disposition === name);
  const lines: string[] = [
    `# Scaffold upgrade ${plan.fromVersion} → ${plan.toVersion}`,
    ``,
    `Incoming Scaffold staged at \`${staged}\`. Snapshot of the current one at \`${snapshot}\`.`,
    `Nothing under \`xforge/scaffold/\` has been touched.`,
    ``,
    `| Disposition | Files |`,
    `|---|---|`,
    `| identical | ${plan.counts.identical} |`,
    `| changed | ${plan.counts.changed} |`,
    `| added | ${plan.counts.added} |`,
    `| project-only | ${plan.counts['project-only']} |`,
    ``,
  ];
  const section = (title: string, name: string, note: string) => {
    const entries = byDisposition(name);
    if (entries.length === 0) return;
    lines.push(`## ${title}`, ``, note, ``);
    for (const entry of entries) lines.push(`- \`${entry.path}\``);
    lines.push(``);
  };
  section('Changed', 'changed', 'Both versions exist and differ. These need judgement.');
  section('Added', 'added', 'New in this release. Copy them in; selecting them is a separate decision.');
  section('Project-only', 'project-only', 'Present here and not in the release. Either your own asset or one upstream dropped — nothing can tell which, so nothing proposes to delete them.');
  if (plan.unselected.length > 0) {
    lines.push(`## Shipped but not selected`, ``,
      `These arrive with the release and this project's Manifest does not list them. Adding one changes what every Agent is told to do, so it is a person's decision.`, ``);
    for (const asset of plan.unselected) lines.push(`- ${asset.kind} \`${asset.id}\``);
    lines.push(``);
  }
  return lines.join('\n');
}

function renderMergePrompt(plan: UpgradePlan, staged: string, snapshot: string): string {
  const changed = plan.entries.filter((entry) => entry.disposition === 'changed').map((entry) => entry.path);
  const added = plan.entries.filter((entry) => entry.disposition === 'added').map((entry) => entry.path);
  const stagedFor = (relative: string) => path.posix.join(staged, relative.slice(MANAGED_ROOT.length));
  return [
    `# Merge the ${plan.toVersion} Scaffold into this project`,
    ``,
    `Invoke the \`xforge-upgrade-scaffold\` Skill and give it this file.`,
    ``,
    `The incoming files are at \`${staged}\`, laid out the way they merge: each of`,
    `${MANAGED_PREFIXES.map((prefix) => `\`${staged}/${prefix.slice(MANAGED_ROOT.length)}\``).join(', ')}`,
    `goes into the tree of the same name under \`${MANAGED_ROOT}\`. Every one of the project's own`,
    `copies is unchanged. A snapshot of them is at \`${snapshot}\` — do not edit that, it is the`,
    `rollback point, and \`protected-files\` denies writes to it.`,
    ``,
    `## Do not read the other ${plan.counts.identical} files`,
    ``,
    `They are byte-identical in both versions. The whole point of this list is that the job is`,
    `${changed.length + added.length} files and not ${plan.entries.length}.`,
    ``,
    `## ${changed.length} file(s) differ — these need judgement`,
    ``,
    ...changed.map((relative) => `- \`${relative}\`  ←  \`${stagedFor(relative)}\``),
    ``,
    `For each: adopt what the new version *rules*, keep what this project *knows*. A Gate carrying`,
    `a real test command, a Skill carrying wording this project chose — those are project facts and`,
    `they survive. Where the two cannot both hold, stop and ask; do not resolve it by preferring the`,
    `newer file wholesale.`,
    ``,
    `A Flow under \`xforge/flows/\` is not like the rest and is never a routine adopt. It states how`,
    `many approvals a Stage needs, who may give them, and where a blocker sends the work back — the`,
    `project's own governance, which somebody chose. Report what differs and let a person decide.`,
    `Adopting one also invalidates the approvals of any Change still running under it, because a Flow`,
    `is an input to the policy snapshot those approvals are bound to.`,
    ``,
    `## ${added.length} file(s) are new`,
    ``,
    ...added.map((relative) => `- \`${stagedFor(relative)}\`  →  \`${relative}\``),
    ``,
    `Copy them in verbatim. Do **not** add them to \`xforge/manifest.yaml\`: a file arriving is not a`,
    `decision to run it. Report them instead.`,
    ``,
    ...(plan.unselected.length > 0 ? [
      `## Shipped and not selected`,
      ``,
      ...plan.unselected.map((asset) => `- ${asset.kind} \`${asset.id}\``),
      ``,
      `Name these in your report as a decision for a person.`,
      ``,
    ] : []),
    `## Never`,
    ``,
    `- Delete a \`project-only\` file. Nothing here knows whether it is yours or was dropped upstream.`,
    /* Read off the ownership table rather than listed here. The four places that answered "which
       files does XForge own" drifted apart once already, and this prompt was one of them: it is what
       an Agent mid-merge actually reads, so a path that stopped being written down here stopped
       being protected regardless of what the policies said. */
    `- Touch any of: ${neverTouchPaths.join(', ')}. The Scaffold is regenerable; the governance`,
    `  record is not, and the rest is either derived or this upgrade's own working state.`,
    `- Update one language of a Skill without the other.`,
    ``,
    `## When done`,
    ``,
    `Run \`xforge upgrade-scaffold --complete\`, which reprojects every target from the merged`,
    `Scaffold and removes \`${UPGRADE_SENTINEL}\`, then \`xforge doctor\`. Report which files you`,
    `merged, which conflicts you stopped on, and which new assets await a person's decision.`,
    ``,
  ].join('\n');
}

export function renderUpgradeText(result: UpgradeResult): string {
  const data = result.data as Record<string, any>;
  if (data.mode === 'stage') {
    return renderPlanText(data.plan as UpgradePlan, String(data.staged), String(data.rollback));
  }
  if (data.mode === 'complete') {
    const adoption = data.adoption as { considered: number; matching: number; notMatching: string[] };
    return [
      `Upgrade ${data.from} → ${data.to} completed at ${data.completedAt}.`,
      `Of ${adoption.considered} files the plan raised, ${adoption.matching} match the incoming Scaffold.`,
      ...(adoption.notMatching.length > 0 ? [`Kept this project's version:`, ...adoption.notMatching.map((p: string) => `  ${p}`)] : []),
      `Recorded in ${UPGRADE_LOG}. The rollback point still stands.`,
    ].join('\n');
  }
  return data.reprojected
    ? `Rolled back to the ${data.to} Scaffold (${data.restored} files) and reprojected. Run \`xforge doctor\`.`
    : `Rolled back to the ${data.to} Scaffold (${data.restored} files). The reprojection did not run; the targets still render the discarded version.`;
}
