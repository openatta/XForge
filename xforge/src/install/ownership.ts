import path from 'node:path';
import type { OwnershipState, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { readJsonIfExists } from '../core/files.js';

export const OWNERSHIP_PATH = 'xforge/.state.json';

export async function readOwnership(project: ProjectContext): Promise<OwnershipState> {
  const filePath = path.join(project.root, 'xforge', '.state.json');
  let state: OwnershipState | null;
  try {
    state = await readJsonIfExists<OwnershipState>(filePath);
  } catch (error) {
    throw new XForgeError(diagnostic('XFORGE_OWNERSHIP_INVALID', `Ownership state is not valid JSON: ${(error as Error).message}`, OWNERSHIP_PATH), { root: project.root });
  }
  if (!state) return { version: 1, generatedAt: new Date(0).toISOString(), files: {} };
  if (state.version !== 1 || !state.files || typeof state.files !== 'object') {
    throw new XForgeError(diagnostic('XFORGE_OWNERSHIP_INVALID', 'Ownership state has an unsupported structure.', OWNERSHIP_PATH), { root: project.root });
  }
  return state;
}
