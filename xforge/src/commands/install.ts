import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { capabilityMatrix } from '../adapters/index.js';
import { checkStructure } from '../core/checker.js';
import { sha256 } from '../core/hash.js';
import { resolvedLock } from '../core/lockfile.js';
import { assertManaged } from '../core/project-loader.js';
import { planInstall } from '../install/planner.js';
import { applyInstallPlan } from '../install/writer.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

export async function executeInstall(project: ProjectContext, options: { target?: TargetId; dryRun: boolean }): Promise<{
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'install');
  const structure = await checkStructure(project);
  const plan = await planInstall(project, options.target);
  const diagnostics = [...structure.diagnostics, ...plan.diagnostics].filter((item, index, all) =>
    index === all.findIndex((candidate) => candidate.code === item.code && candidate.path === item.path && candidate.message === item.message));
  const lockContent = await resolvedLock(project, plan.resources);
  const changes = [...plan.changes];
  const actionable = plan.changes.some((item) => ['create', 'modify', 'delete'].includes(item.action));
  const statePath = path.join(project.root, 'xforge', '.state.json');
  const stateExists = await exists(statePath);
  const stateContent = `${JSON.stringify(plan.next, null, 2)}\n`;
  if (actionable || !stateExists) changes.push({ action: stateExists ? 'modify' : 'create', path: 'xforge/.state.json', digest: sha256(stateContent), source: 'xforge:ownership' });

  const currentLock = await readFile(project.lockPath, 'utf8').catch(() => null);
  const lockChanged = currentLock !== lockContent;
  if (lockChanged) changes.push({ action: currentLock === null ? 'create' : 'modify', path: 'xforge/lock.yaml', digest: sha256(lockContent), source: 'xforge:lock' });

  const hasErrors = diagnostics.some((item) => item.severity === 'error');
  if (!options.dryRun && !hasErrors && (actionable || !stateExists || lockChanged)) {
    await applyInstallPlan(project, plan, lockContent, { writeOwnership: actionable || !stateExists, writeLock: lockChanged });
  }
  return {
    data: {
      dryRun: options.dryRun,
      targets: plan.targets,
      capabilities: capabilityMatrix(plan.targets),
      summary: Object.fromEntries(['create', 'modify', 'delete', 'skip', 'conflict'].map((action) => [action, changes.filter((item) => item.action === action).length])),
    },
    diagnostics,
    changes,
  };
}
