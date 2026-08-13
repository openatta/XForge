import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import { CLI_VERSION } from '../constants.js';
import type { FileChange, ProjectContext } from '../types.js';
import { loadBundledScaffold } from '../core/bundled-scaffold.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { localizedVariant } from '../core/language.js';
import { updateUpgradeAvailable, upgradedProjectContext } from '../core/project-loader.js';
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

/**
 * Replaces a direct-child `fieldName: value` line inside the block that follows a `blockKey:`
 * header line at `blockIndent`, without touching anything outside that block or any more-deeply-
 * nested field of the same name (`scaffold.version` vs. `scaffold.source.version`). Key *order*
 * inside the block does not matter — only its indentation depth — so this survives a round trip
 * through a YAML formatter that reorders keys but preserves nesting depth. Returns `null`,
 * changing nothing, if the block or the field within it isn't found in the expected shape.
 */
function replaceFieldInBlock(text: string, blockKey: string, blockIndent: number, fieldName: string, fieldIndent: number, value: string): string | null {
  const blockPattern = new RegExp(`^${' '.repeat(blockIndent)}${blockKey}:\\n((?:${' '.repeat(fieldIndent)}[^\\n]*\\n?)*)`, 'm');
  const blockMatch = blockPattern.exec(text);
  if (!blockMatch) return null;
  const fieldPattern = new RegExp(`^${' '.repeat(fieldIndent)}${fieldName}: [^\\n]+`, 'm');
  if (!fieldPattern.test(blockMatch[1]!)) return null;
  const newBody = blockMatch[1]!.replace(fieldPattern, `${' '.repeat(fieldIndent)}${fieldName}: ${value}`);
  return text.slice(0, blockMatch.index) + `${' '.repeat(blockIndent)}${blockKey}:\n${newBody}` + text.slice(blockMatch.index + blockMatch[0].length);
}

/**
 * Textual surgery over the manifest: rewrites only the release-stamped `version:` pins — the
 * `xforge` CLI identity block, and the Scaffold block's own `version:` plus `source.version:` —
 * to the running CLI version. Every other line (all other fields, orderings, comments) is
 * preserved byte for byte. Fails loudly when any of the three pins is missing from its expected
 * shape: silently leaving a stale pin behind would report a successful upgrade that never
 * happened. The remaining identity fields (`source`, `package`, `protocol`) are schema-
 * constrained constants that `updateUpgradeAvailable` has already verified.
 */
function bumpManifestVersion(source: string, project: ProjectContext): string {
  let next = source;
  for (const [blockKey, blockIndent, fieldName, fieldIndent] of [
    ['scaffold', 0, 'version', 2],
    ['source', 2, 'version', 4],
    ['xforge', 0, 'version', 2],
  ] as const) {
    const replaced = replaceFieldInBlock(next, blockKey, blockIndent, fieldName, fieldIndent, CLI_VERSION);
    if (replaced === null) {
      throw new XForgeError(diagnostic(
        'XFORGE_MANIFEST_VERSION_FIELD_NOT_FOUND',
        `Could not locate ${blockKey}.${fieldName} in xforge/manifest.yaml in the expected shape to reconcile the declared CLI version. Edit it by hand instead.`,
        'xforge/manifest.yaml',
      ), { root: project.root });
    }
    next = replaced;
  }
  return next;
}

/**
 * The controlled upgrade channel: a project whose declared CLI version is OLDER than the running
 * one (same protocol) may `xforge update` to lift the declaration to the running identity, then
 * re-project from the bundled Scaffold. Downgrades stay hard-blocked in project-loader. Returns
 * the manifest change (dry-run: not written) and the context to plan against.
 */
async function applyUpgradeIdentity(project: ProjectContext, dryRun: boolean): Promise<{ project: ProjectContext; changes: FileChange[] }> {
  if (!updateUpgradeAvailable(project)) return { project, changes: [] };
  /* A never-installed project must fail the whole command BEFORE the version pins are written:
     bumping the manifest and then failing projection would leave a partial write behind. */
  await assertInstalledRecord(project, 'update');
  const upgraded = upgradedProjectContext(project);
  const content = bumpManifestVersion(await readFile(path.join(project.root, 'xforge', 'manifest.yaml'), 'utf8'), project);
  if (!dryRun) await atomicWrite(project.root, 'xforge/manifest.yaml', content);
  return {
    project: upgraded,
    changes: [{ action: 'modify', path: 'xforge/manifest.yaml', digest: sha256(content), source: 'xforge:upgrade' }],
  };
}

export async function executeUpdate(project: ProjectContext, options: { target?: TargetId; dryRun: boolean }) {
  const { project: current, changes: identityChanges } = await applyUpgradeIdentity(project, options.dryRun);
  const result = await executeProjection(current, 'update', options);
  if (result.diagnostics.some((item) => item.severity === 'error')) return { ...result, changes: [...identityChanges, ...result.changes] };
  const seeded = await seedMissingConstitutionFiles(current, options.dryRun);
  return { ...result, changes: [...identityChanges, ...seeded, ...result.changes] };
}
