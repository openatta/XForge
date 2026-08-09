import type { TargetId } from '../constants.js';
import type { ProjectContext } from '../types.js';
import { executeProjection } from './projection.js';

export async function executeSync(project: ProjectContext, options: { target?: TargetId; dryRun: boolean; verifyDigests: boolean }) {
  return executeProjection(project, 'sync', options);
}
