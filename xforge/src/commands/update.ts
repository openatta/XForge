import { access } from 'node:fs/promises';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import type { FileChange, ProjectContext } from '../types.js';
import { loadBundledScaffold } from '../core/bundled-scaffold.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { localizedVariant } from '../core/language.js';
import { canUpgradeDeclaredCli, reconcileDeclaredCliVersion } from '../core/project-loader.js';
import { assertInstalledRecord } from '../install/planner.js';
import { executeProjection } from './projection.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

/**
 * `xforge init` seeds xforge/constitution.md (+ constitution_cn.md, once a project's language
 * is zh-CN) once, from whatever the pinned CLI bundled at the time. A project that initialized
 * on an older CLI never gets a localized variant a newer CLI now bundles, and update/sync's
 * target-projection logic never looks at xforge/-root files to notice. This adds exactly that
 * one missing-file catch-up, seeding only files that do not exist yet — an already-customized
 * Constitution is never touched.
 */
async function seedMissingConstitutionFiles(project: ProjectContext, dryRun: boolean): Promise<FileChange[]> {
  const relative = 'xforge/constitution.md';
  const localized = localizedVariant(relative);
  const missing: string[] = [];
  for (const candidate of [relative, localized]) {
    if (!await exists(path.join(project.root, ...candidate.split('/')))) missing.push(candidate);
  }
  if (missing.length === 0) return [];
  const bundle = await loadBundledScaffold();
  const changes: FileChange[] = [];
  for (const candidate of missing) {
    const content = bundle.files.get(candidate);
    if (!content) continue;
    if (!dryRun) await atomicWrite(project.root, candidate, content);
    changes.push({ action: 'create', path: candidate, digest: sha256(content), source: `npm:${bundle.package}@${bundle.version}:scaffold` });
  }
  return changes;
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
  const result = await executeProjection(project, 'update', options);
  if (result.diagnostics.some((item) => item.severity === 'error')) return { ...result, changes: [...versionChanges, ...result.changes] };
  const seeded = await seedMissingConstitutionFiles(project, options.dryRun);
  return { ...result, changes: [...versionChanges, ...seeded, ...result.changes] };
}
