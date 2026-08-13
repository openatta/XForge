import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { capabilityMatrix } from '../adapters/index.js';
import { checkStructure } from '../core/checker.js';
import { sha256 } from '../core/hash.js';
import { resolvedLock } from '../core/lockfile.js';
import { assertManaged, assertUpdateCompatible } from '../core/project-loader.js';
import { planProjection, type ProjectionMode } from '../install/planner.js';
import { applyInstallPlan } from '../install/writer.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

export interface ProjectionCommandOptions {
  target?: TargetId;
  dryRun: boolean;
  verifyDigests?: boolean;
  /**
   * `--adopt`: re-baseline managed destinations that drifted from their installation record instead
   * of refusing. This whole command is all-or-nothing — `hasErrors` below blocks every write, not
   * just the write to the offending file — so one hand-edited managed file otherwise stops every
   * other file from syncing. See `ProjectionOptions.adopt` for what it does and does not cover.
   */
  adopt?: boolean;
}

export async function executeProjection(
  project: ProjectContext,
  mode: ProjectionMode,
  options: ProjectionCommandOptions,
): Promise<{ data: Record<string, unknown>; diagnostics: Diagnostic[]; changes: FileChange[] }> {
  if (mode === 'update') assertUpdateCompatible(project);
  else assertManaged(project, mode);
  const structure = await checkStructure(project);
  const plan = await planProjection(project, { mode, target: options.target, verifyDigests: options.verifyDigests, adopt: options.adopt });
  const updateResolvableCodes = new Set(['XFORGE_LOCK_CLI_MISMATCH', 'XFORGE_LOCK_PROTOCOL_MISMATCH']);
  const structureDiagnostics = mode === 'update'
    ? structure.diagnostics.filter((item) => !updateResolvableCodes.has(item.code))
    : structure.diagnostics;
  const diagnostics = [...structureDiagnostics, ...plan.diagnostics].filter((item, index, all) =>
    index === all.findIndex((candidate) => candidate.code === item.code && candidate.path === item.path && candidate.message === item.message));
  const lockContent = await resolvedLock(project, plan.resources);
  const changes = [...plan.changes];
  const statePath = path.join(project.root, 'xforge', '.state.json');
  const stateExists = await exists(statePath);
  const stateContent = `${JSON.stringify(plan.next, null, 2)}\n`;
  if (plan.stateChanged) changes.push({
    action: stateExists ? 'modify' : 'create',
    path: 'xforge/.state.json',
    digest: sha256(stateContent),
    source: 'xforge:ownership',
  });

  const currentLock = await readFile(project.lockPath, 'utf8').catch(() => null);
  const lockChanged = currentLock !== lockContent;
  if (lockChanged) changes.push({
    action: currentLock === null ? 'create' : 'modify',
    path: 'xforge/lock.yaml',
    digest: sha256(lockContent),
    source: 'xforge:lock',
  });

  const hasErrors = diagnostics.some((item) => item.severity === 'error');
  const actionable = changes.some((item) => ['create', 'modify', 'delete'].includes(item.action));
  if (!options.dryRun && !hasErrors && actionable) {
    await applyInstallPlan(project, plan, lockContent, { writeOwnership: plan.stateChanged, writeLock: lockChanged });
  }

  return {
    data: {
      mode,
      dryRun: options.dryRun,
      targets: plan.targets,
      capabilities: capabilityMatrix(plan.targets),
      recordVersion: 2,
      ...plan.stats,
      summary: Object.fromEntries(['create', 'modify', 'delete', 'skip', 'conflict'].map((action) => [action, changes.filter((item) => item.action === action).length])),
    },
    diagnostics,
    changes,
  };
}
