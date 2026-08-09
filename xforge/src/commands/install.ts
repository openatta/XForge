import type { TargetId } from '../constants.js';
import type { ProjectContext } from '../types.js';
import { executeProjection } from './projection.js';

export async function executeInstall(project: ProjectContext, options: { target?: TargetId; dryRun: boolean }) {
  return executeProjection(project, 'install', options);
}
