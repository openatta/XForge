import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { assertManaged, writeScaffoldVersion } from '../core/project-loader.js';
import { safeResolve } from '../core/path-safety.js';
import { loadBundledScaffold } from '../core/bundled-scaffold.js';
import {
  MANAGED_PREFIXES, MANAGED_ROOT, ROLLBACK_MANIFEST, SCAFFOLD_PREFIX, UPGRADE_LOG, adoptionReport, buildUpgradePlan, digestMap, isManagedPath,
  driftedPaths, rollbackDirectory, stagedDirectory,
  type RollbackManifest, type UpgradePlan,
} from '../core/upgrade.js';

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
 * - **stage** copies the incoming Scaffold to a *visible* `xforge/scaffold-<version>/`. Visible so
 *   an unfinished upgrade is obvious in a file listing rather than hidden in a dotfile.
 * - **complete** deletes that directory and records what `xforge/scaffold/**` became, which is the
 *   only moment at which a post-merge baseline exists.
 * - **rollback** restores the single snapshot, and refuses when work has happened since — without
 *   the baseline `complete` records, it could not tell.
 */

export type UpgradeMode = 'stage' | 'complete' | 'rollback';

export interface UpgradeOptions {
  mode: UpgradeMode;
  dryRun?: boolean;
  force?: boolean;
  withActiveChanges?: boolean;
}

export interface UpgradeResult {
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
 * Two trees now, not one: `xforge/scaffold/` and `xforge/flows/`. A Flow lives beside the Scaffold
 * rather than inside it, so for as long as this read one directory a Flow was never brought,
 * diffed, or mentioned -- and the upgrade log's "every file the plan named now matches" was true of
 * a plan that could not name it.
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

async function readRollbackManifest(root: string): Promise<RollbackManifest | null> {
  try { return JSON.parse(await readFile(path.join(root, ...ROLLBACK_MANIFEST.split('/')), 'utf8')) as RollbackManifest; }
  catch { return null; }
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
  const staged = stagedDirectory(toVersion);
  const diagnostics: Diagnostic[] = [];

  const existing = await readTree(project.root, staged, '');
  if (existing.size > 0) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_ALREADY_STAGED',
      `${staged} already exists, so an upgrade to ${toVersion} is already in progress. Finish the merge and run \`xforge upgrade-scaffold --complete\`, or \`xforge upgrade-scaffold --rollback\` to abandon it.`,
      staged,
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
    return { data: { mode: 'stage', dryRun: true, plan, staged, rollback: rollbackDirectory(fromVersion) }, diagnostics, changes: [] };
  }

  const changes: FileChange[] = [];
  /* The snapshot is written before anything else: it is the only thing that makes the rest undoable. */
  const snapshot = rollbackDirectory(fromVersion);
  await rm(path.join(project.root, 'xforge', '.rollback'), { recursive: true, force: true });
  for (const [relative, content] of current) {
    const target = path.posix.join(snapshot, relative.slice(MANAGED_ROOT.length));
    await atomicWrite(project.root, target, content);
  }
  const manifestRecord: RollbackManifest = {
    fromVersion, toVersion, stagedAt: new Date().toISOString(), completedAt: null,
    gitHead: gitHead(project.root), before: digestMap(current), after: null,
  };
  await atomicWrite(project.root, ROLLBACK_MANIFEST, `${JSON.stringify(manifestRecord, null, 2)}\n`);
  changes.push({ action: 'create', path: snapshot, source: `snapshot:${fromVersion}` });

  for (const [relative, content] of incoming) {
    const target = path.posix.join(staged, relative.slice(MANAGED_ROOT.length));
    await atomicWrite(project.root, target, content);
    changes.push({ action: 'create', path: target, digest: sha256(content), source: `npm:${bundle.package}@${toVersion}:scaffold` });
  }

  for (const [name, content] of Object.entries(stagedDocuments(plan, staged, snapshot))) {
    await atomicWrite(project.root, path.posix.join(staged, name), content);
    changes.push({ action: 'create', path: path.posix.join(staged, name), digest: sha256(content) });
  }

  return { data: { mode: 'stage', plan, staged, rollback: snapshot }, diagnostics, changes };
}

async function complete(project: ProjectContext, options: UpgradeOptions): Promise<UpgradeResult> {
  const record = await readRollbackManifest(project.root);
  if (!record) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_NOT_STAGED',
      'No upgrade is in progress: there is no rollback snapshot to complete against. Run `xforge upgrade-scaffold` first.',
      ROLLBACK_MANIFEST,
    ));
  }
  const staged = stagedDirectory(record.toVersion);
  const stagedFiles = await readTree(project.root, staged, MANAGED_ROOT);
  if (stagedFiles.size === 0 && record.completedAt) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_ALREADY_COMPLETE',
      `The upgrade to ${record.toVersion} was already completed at ${record.completedAt}.`,
      ROLLBACK_MANIFEST,
    ));
  }

  const planText = await readFile(path.join(project.root, ...staged.split('/'), 'plan.json'), 'utf8').catch(() => null);
  const merged = await currentManaged(project.root);
  const report = planText
    ? adoptionReport(JSON.parse(planText) as UpgradePlan, merged)
    : { considered: 0, matching: 0, notMatching: [] as string[] };

  if (options.dryRun) {
    return { data: { mode: 'complete', dryRun: true, staged, adoption: report }, diagnostics: [], changes: [] };
  }

  const changes: FileChange[] = [];
  await rm(path.join(project.root, ...staged.split('/')), { recursive: true, force: true });
  changes.push({ action: 'delete', path: staged });

  /*
   * The merge is adopted, so now — and only now — the Manifest may say the Scaffold is this version.
   * `xforge update` deliberately no longer does this: it moves the CLI pin, because the CLI is what
   * it changed. Advancing the Scaffold pin here is what keeps `fromVersion` on the *next* upgrade
   * honest, since `stage()` reads it straight back out of `scaffold.source.version`.
   */
  changes.push(...await writeScaffoldVersion(project, record.toVersion, false));

  const completedAt = new Date().toISOString();
  await atomicWrite(project.root, ROLLBACK_MANIFEST, `${JSON.stringify({
    ...record, completedAt, after: digestMap(merged),
  } satisfies RollbackManifest, null, 2)}\n`);
  changes.push({ action: 'modify', path: ROLLBACK_MANIFEST });

  await appendUpgradeLog(project.root, record, completedAt, report);
  changes.push({ action: 'modify', path: UPGRADE_LOG });

  return {
    data: { mode: 'complete', from: record.fromVersion, to: record.toVersion, completedAt, adoption: report },
    diagnostics: [], changes,
  };
}

async function rollback(project: ProjectContext, options: UpgradeOptions): Promise<UpgradeResult> {
  const record = await readRollbackManifest(project.root);
  if (!record) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_NO_ROLLBACK',
      'There is nothing to roll back to. Exactly one snapshot is kept, and it is taken when an upgrade is staged.',
      ROLLBACK_MANIFEST,
    ));
  }

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

  const snapshot = rollbackDirectory(record.fromVersion);
  const saved = await readTree(project.root, snapshot, MANAGED_ROOT);
  if (saved.size === 0) {
    throw new XForgeError(diagnostic(
      'XFORGE_UPGRADE_ROLLBACK_MISSING',
      `The rollback snapshot at ${snapshot} is empty or missing, so ${record.fromVersion} cannot be restored.`,
      snapshot,
    ));
  }

  if (options.dryRun) {
    return { data: { mode: 'rollback', dryRun: true, to: record.fromVersion, files: saved.size, drifted }, diagnostics: [], changes: [] };
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
  for (const prefix of MANAGED_PREFIXES.filter((prefix) => !savedPrefixes.includes(prefix))) {
    diagnostics.push(diagnostic(
      'XFORGE_UPGRADE_ROLLBACK_TREE_UNCOVERED',
      `The snapshot at ${snapshot} holds no files under ${prefix}, so that tree was left as it stands rather than restored. It was taken by a CLI that managed ${SCAFFOLD_PREFIX} alone, and removing a tree it cannot put back would discard more than this rollback was asked to. Check ${prefix} against the ${record.fromVersion} release by hand.`,
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
  await rm(path.join(project.root, ...stagedDirectory(record.toVersion).split('/')), { recursive: true, force: true });
  await rm(path.join(project.root, 'xforge', '.rollback'), { recursive: true, force: true });
  changes.push({ action: 'delete', path: 'xforge/.rollback' });

  return {
    data: { mode: 'rollback', to: record.fromVersion, restored: saved.size, forced: Boolean(options.force && drifted.length) },
    diagnostics: [...diagnostics, diagnostic(
      'XFORGE_UPGRADE_ROLLED_BACK',
      `Restored the ${record.fromVersion} Scaffold. Run \`xforge install\` to reproject it, then \`xforge doctor\`.`,
      'xforge/scaffold', 'info',
    )],
    changes,
  };
}

/**
 * The append-only history, kept apart from the rollback record on purpose.
 *
 * `xforge/.rollback/manifest.json` is a mechanism: it holds one upgrade's digests and is replaced by
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
    record.gitHead ? `- Git HEAD at staging: ${record.gitHead}` : `- Not a Git working tree at staging`,
    `- Of ${report.considered} files the plan raised, ${kept}.`,
    ``,
  ].join('\n');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${existing.trimEnd()}\n${entry}`, 'utf8');
}

/** `plan.json`, its readable twin, and the prompt that hands the merge to an Agent. */
function stagedDocuments(plan: UpgradePlan, staged: string, snapshot: string): Record<string, string> {
  return {
    'plan.json': `${JSON.stringify(plan, null, 2)}\n`,
    'plan.md': renderPlanText(plan, staged, snapshot),
    'MERGE.md': renderMergePrompt(plan, staged, snapshot),
  };
}

export function renderPlanText(plan: UpgradePlan, staged: string, snapshot: string): string {
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

export function renderMergePrompt(plan: UpgradePlan, staged: string, snapshot: string): string {
  const changed = plan.entries.filter((entry) => entry.disposition === 'changed').map((entry) => entry.path);
  const added = plan.entries.filter((entry) => entry.disposition === 'added').map((entry) => entry.path);
  const stagedFor = (relative: string) => path.posix.join(staged, relative.slice(MANAGED_ROOT.length));
  return [
    `# Merge the ${plan.toVersion} Scaffold into this project`,
    ``,
    `Invoke the \`xforge-upgrade-scaffold\` Skill and give it this file.`,
    ``,
    `The incoming files are at \`${staged}\`, laid out the way they belong: \`${staged}/scaffold/\``,
    `merges into \`xforge/scaffold/\`, and \`${staged}/flows/\` into \`xforge/flows/\`. Both of the`,
    `project's own copies are unchanged. A snapshot of them is at \`${snapshot}\` — do not edit that,`,
    `it is the rollback point.`,
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
    `- Touch \`xforge/changes/\`, \`xforge/specs/\`, the audit chain, approvals, \`constitution.md\`, or`,
    `  \`architecture.md\`. The Scaffold is regenerable; the governance record is not.`,
    `- Update one language of a Skill without the other.`,
    ``,
    `## When done`,
    ``,
    `Run \`xforge upgrade-scaffold --complete\`, then \`xforge install\`, then \`xforge doctor\`. Report which`,
    `files you merged, which conflicts you stopped on, and which new assets await a person's decision.`,
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
  return `Rolled back to the ${data.to} Scaffold (${data.restored} files). Run \`xforge install\`, then \`xforge doctor\`.`;
}
