import { access } from 'node:fs/promises';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import type { FileChange, ProjectContext } from '../types.js';
import { loadBundledScaffold } from '../core/bundled-scaffold.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { localizedVariant } from '../core/language.js';
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

export async function executeUpdate(project: ProjectContext, options: { target?: TargetId; dryRun: boolean }) {
  const result = await executeProjection(project, 'update', options);
  if (result.diagnostics.some((item) => item.severity === 'error')) return result;
  const seeded = await seedMissingConstitutionFiles(project, options.dryRun);
  return { ...result, changes: [...seeded, ...result.changes] };
}
