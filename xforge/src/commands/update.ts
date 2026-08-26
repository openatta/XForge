import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CLI_VERSION, type TargetId } from '../constants.js';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { loadBundledScaffold } from '../core/bundled-scaffold.js';
import { diagnostic } from '../core/errors.js';
import { atomicWrite, exists } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { localizedVariant } from '../core/language.js';
import { canUpgradeDeclaredCli, compareVersions, loadProject, reconcileDeclaredCliVersion } from '../core/project-loader.js';
import { safeResolve } from '../core/path-safety.js';
import { assertInstalledRecord } from '../install/planner.js';
import { executeProjection } from './projection.js';

/**
 * `xforge init` seeds the `xforge/`-root Agent documents once, from whatever the pinned CLI bundled
 * at the time, and update/sync's target-projection logic never looks at those files afterwards. A
 * project initialized on an older CLI therefore never gains a document a newer CLI now bundles.
 * This is exactly that catch-up: it seeds only files that do not exist, so an already-customized
 * Constitution is never touched.
 *
 * It seeds the canonical name only. Seeding `_cn` alongside would re-create the two-file layout
 * `init` now collapses, and would do it on every update — putting an English `constitution.md`
 * next to the Chinese one a zh-CN project is actually reading, which is the confusion the collapse
 * exists to remove. A project that already has the legacy pair keeps it: both names exist, so
 * nothing here is missing and nothing is written.
 */
async function seedMissingRootDocuments(project: ProjectContext, dryRun: boolean): Promise<FileChange[]> {
  const language = project.manifest.scaffold?.language;
  const bundle = await loadBundledScaffold();
  const changes: FileChange[] = [];
  for (const relative of ['xforge/constitution.md', 'xforge/XFORGE.md']) {
    if (await exists(path.join(project.root, ...relative.split('/')))) continue;
    /* A zh-CN project reads the canonical name, so the canonical name has to receive zh-CN text. */
    const source = language === 'zh-CN' ? localizedVariant(relative) : relative;
    const content = bundle.files.get(source) ?? bundle.files.get(relative);
    if (!content) continue;
    if (!dryRun) await atomicWrite(project.root, relative, content);
    changes.push({ action: 'create', path: relative, digest: sha256(content), source: `npm:${bundle.package}@${bundle.version}:scaffold` });
  }
  return changes;
}

/**
 * Sentences that exist only inside the Gates XForge shipped as npm placeholders.
 *
 * They are the marker for "this file is the one we shipped, untouched". Matching on the text rather
 * than on a table of historical digests is both simpler and more honest about what is being
 * decided: these strings were written by the placeholder and by nothing else, so a Gate containing
 * one is a Gate nobody has adapted to their project.
 */
const PLACEHOLDER_SENTINELS = ['passing WITHOUT asserting anything', 'passing WITHOUT scanning anything'];

/**
 * Replaces a shipped npm placeholder Gate with the `builtin: declared` form.
 *
 * This is the only route by which the fix reaches a project that already exists. `xforge/scaffold/**`
 * is seeded once by `init` and never updated afterwards, so a project created on any earlier release
 * keeps its `npm test` Gate through every upgrade — and that Gate reports `passed` without running
 * anything on any project that is not Node. Shipping a corrected Gate in the bundle fixes new
 * projects only; this fixes the ones already out there.
 *
 * A Gate that has been edited is never touched. The sentinel is what distinguishes "still the file
 * we shipped" from "the project's own", and rewriting somebody's real test command because a newer
 * default exists would be a far worse failure than the one being repaired.
 *
 * The replacement is read from the bundled Scaffold rather than written out here. It used to be a
 * literal copied into this function, and a copy of a shipped file is a copy that drifts: the Gates
 * reached `version: 4` with a `maxOutputBytes` cap while this literal still said `version: 3` and
 * capped nothing, so the one route by which a fix reaches an existing project delivered a Gate two
 * versions behind the one `init` seeds — and the migration test could not see it, because asserting
 * `builtin: declared` is true of both. Taking the bundle's own bytes makes a migrated project
 * byte-identical to a freshly initialized one and removes the second place a Gate is defined.
 */
async function migratePlaceholderGates(project: ProjectContext, dryRun: boolean): Promise<{ changes: FileChange[]; diagnostics: Diagnostic[] }> {
  const changes: FileChange[] = [];
  const diagnostics: Diagnostic[] = [];
  const bundle = await loadBundledScaffold();
  for (const name of ['unit-tests', 'security-scan']) {
    const relative = `xforge/scaffold/gates/${name}.yaml`;
    let current: string;
    try { current = await readFile(await safeResolve(project.root, relative), 'utf8'); }
    catch { continue; }
    if (!PLACEHOLDER_SENTINELS.some((sentinel) => current.includes(sentinel))) continue;

    /* `loadBundledScaffold` has already refused a package whose payload is missing or fails its own
       digest manifest, so an absent entry here is not a degraded install to work around — leaving
       the placeholder in place is safer than inventing a replacement for it. */
    const replacement = bundle.files.get(relative);
    if (!replacement) continue;
    if (!dryRun) await atomicWrite(project.root, relative, replacement);
    changes.push({ action: 'modify', path: relative, digest: sha256(replacement), source: 'migrate:placeholder-gate' });
    diagnostics.push(diagnostic(
      'XFORGE_VERIFICATION_GATE_MIGRATED',
      `Gate ${name} was still the shipped npm placeholder, which reported passed without running anything unless this project happened to be a Node project. It now runs what manifest.verification.${name} declares, and refuses while that is empty. Declare this project's real ${name === 'unit-tests' ? 'test' : 'dependency or SAST scan'} command.`,
      relative,
      'warning',
    ));
  }
  return { changes, diagnostics };
}

export async function executeUpdate(project: ProjectContext, options: { target?: TargetId; dryRun: boolean; adopt?: boolean }) {
  /*
   * Two orderings matter here, and they are independent of each other.
   *
   * Reconciling before the projection (a no-op unless the declared CLI version is a clean,
   * Protocol-compatible upgrade — see `canUpgradeDeclaredCli`) means `executeProjection`'s
   * `assertUpdateCompatible` gate below sees an already-consistent Manifest instead of hard-
   * blocking update itself from ever reaching the code that exists to resolve exactly this kind of
   * staleness.
   *
   * The installation-record guard then has to come before the reconciliation, because the
   * reconciliation *writes*: `planProjection` enforces the same precondition, but only after the
   * Manifest's three version pins have already been rewritten on disk, so a project that was
   * `init`ed but never `install`ed would end up with a bumped Manifest and a failed command — a
   * write left behind by a command that reported failure. This adds an earlier, cheaper
   * precondition only; it does not reorder the reconciliation relative to the projection.
   *
   * It is gated on the same `canUpgradeDeclaredCli` predicate the reconciliation itself is gated
   * on, deliberately: when nothing would be written there is nothing to protect, and letting those
   * projects fall through keeps the more informative diagnostic they get today (an unreconcilable
   * declared version reports XFORGE_CLI_IDENTITY_MISMATCH / XFORGE_PROTOCOL_MISMATCH with its
   * `resolve-declared-xforge` guidance, rather than being flattened into XFORGE_NOT_INSTALLED).
   */
  if (canUpgradeDeclaredCli(project.manifest)) await assertInstalledRecord(project, 'update');
  const versionChanges = await reconcileDeclaredCliVersion(project, options.dryRun);
  /*
   * Say the other half out loud. `update` moves the CLI pin and reprojects the targets; it does not
   * touch `xforge/scaffold/**`, which is the project's own copy and is merged forward deliberately.
   * Before the pins were separated this gap was invisible — `update` wrote the new number into
   * `scaffold.version` too, so a project whose Skills and Gates were three releases old reported
   * itself as current. Now the lag is stated, with the command that closes it.
   */
  const scaffoldLag = compareVersions(project.manifest.scaffold.version, CLI_VERSION) < 0
    ? [diagnostic(
      'XFORGE_SCAFFOLD_BEHIND_CLI',
      `The CLI is ${CLI_VERSION} and this project's Scaffold is ${project.manifest.scaffold.version}. update does not touch xforge/scaffold/** — that copy is yours, and newer Skills, Gates and Rules reach it only through a merge you review. Run \`xforge upgrade-scaffold --dry-run\` to see what changed.`,
      'xforge/scaffold',
      'warning',
    )]
    : [];
  const migrated = await migratePlaceholderGates(project, options.dryRun);
  /*
   * Re-read the project after a migration wrote one of its resources. `project` carries resource
   * content that was read before `executeUpdate` was called, so the projection would otherwise lock
   * the digests of the placeholder Gate it had just replaced — leaving the run reporting
   * XFORGE_LOCK_RESOURCES_MISMATCH and needing a second `update` to converge.
   */
  const migratedProject = migrated.changes.length > 0 && !options.dryRun
    ? await loadProject(project.root, { exactRoot: true })
    : project;
  const result = await executeProjection(migratedProject, 'update', options);
  /*
   * `executeProjection` reads the structure before it rewrites the lock, so a migration performed
   * moments earlier in this same run shows up as a stale-resources warning that this very run has
   * already resolved. Reporting it would tell the reader something is inconsistent at the exact
   * moment it was made consistent. Suppressed only when a migration actually wrote something —
   * a genuinely stale lock in any other update still reports.
   */
  const selfInflicted = migrated.changes.length > 0 ? new Set(['XFORGE_LOCK_RESOURCES_MISMATCH']) : new Set<string>();
  const diagnostics = [...migrated.diagnostics, ...scaffoldLag, ...result.diagnostics.filter((item) => !selfInflicted.has(item.code))];
  if (result.diagnostics.some((item) => item.severity === 'error')) {
    return { ...result, diagnostics, changes: [...versionChanges, ...migrated.changes, ...result.changes] };
  }
  const seeded = await seedMissingRootDocuments(migratedProject, options.dryRun);
  return { ...result, diagnostics, changes: [...versionChanges, ...migrated.changes, ...seeded, ...result.changes] };
}
