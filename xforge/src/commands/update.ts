import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import { CLI_VERSION } from '../constants.js';
import type { FileChange, ProjectContext } from '../types.js';
import { loadBundledScaffold } from '../core/bundled-scaffold.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { localizedVariant } from '../core/language.js';
import { updateUpgradeAvailable, upgradedProjectContext } from '../core/project-loader.js';
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
 * Textual surgery over the manifest: rewrites only the release-stamped `version:` pins — the
 * `xforge` CLI identity block, and the Scaffold block's own `version:` plus `source.version:` —
 * to the running CLI version. Every other line (all other fields, orderings, comments) is
 * preserved byte for byte. The remaining identity fields (`source`, `package`, `protocol`) are
 * schema-constrained constants that cannot differ from the running CLI when an upgrade is legal.
 */
function bumpManifestVersion(source: string): string {
  const lines = source.split('\n');
  const topLevel = /^[A-Za-z][A-Za-z0-9_-]*:/;
  /* Replace every `version:` line at the given indents inside the block, whatever the key order. */
  const rewriteBlock = (start: number, anchors: RegExp[]): void => {
    let cursor = start + 1;
    while (cursor < lines.length && !topLevel.test(lines[cursor]!)) cursor += 1;
    for (let j = start + 1; j < cursor; j += 1) {
      if (anchors.some((anchor) => anchor.test(lines[j]!))) {
        lines[j] = lines[j]!.replace(/version:.*$/, `version: ${CLI_VERSION}`);
      }
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (/^xforge:$/.test(lines[i]!)) rewriteBlock(i, [/^  version:/]);
    else if (/^scaffold:$/.test(lines[i]!)) rewriteBlock(i, [/^  version:/, /^    version:/]);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The controlled upgrade channel: a project whose declared CLI version is OLDER than the running
 * one (same protocol) may `xforge update` to lift the declaration to the running identity, then
 * re-project from the bundled Scaffold. Downgrades stay hard-blocked in project-loader. Returns
 * the manifest change (dry-run: not written) and the context to plan against.
 */
async function applyUpgradeIdentity(project: ProjectContext, dryRun: boolean): Promise<{ project: ProjectContext; changes: FileChange[] }> {
  if (!updateUpgradeAvailable(project)) return { project, changes: [] };
  const upgraded = upgradedProjectContext(project);
  const content = bumpManifestVersion(await readFile(path.join(project.root, 'xforge', 'manifest.yaml'), 'utf8'));
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
