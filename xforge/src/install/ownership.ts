import path from 'node:path';
import type {
  LegacyManagedFileRecord,
  ManagedFileRecord,
  OwnershipState,
  OwnershipStateV1,
  OwnershipStateV2,
  ProjectContext,
  TargetInstallationState,
} from '../types.js';
import type { TargetId } from '../constants.js';
import { PROTOCOL_VERSION } from '../constants.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { readJsonIfExists } from '../core/files.js';
import { sha256, stableStringify } from '../core/hash.js';
import { getAdapter } from '../adapters/index.js';

export const OWNERSHIP_PATH = 'xforge/.state.json';

export function manifestSelectionDigest(project: ProjectContext): string {
  return sha256(stableStringify({
    scaffold: {
      skills: project.manifest.scaffold.skills,
      agents: project.manifest.scaffold.agents,
      rules: project.manifest.scaffold.rules,
      hooks: project.manifest.scaffold.hooks,
      gates: project.manifest.scaffold.gates,
    },
    scripts: project.manifest.scripts ?? [],
  }));
}

export function scaffoldIdentity(project: ProjectContext): string {
  return sha256(stableStringify({ version: project.manifest.scaffold.version, source: project.manifest.scaffold.source }));
}

export function declaredCliIdentity(project: ProjectContext): string {
  return sha256(stableStringify(project.manifest.xforge));
}

export function emptyOwnership(project: ProjectContext, now = new Date(0).toISOString()): OwnershipStateV2 {
  return {
    version: 2,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: now,
    manifestSelectionDigest: manifestSelectionDigest(project),
    manifestTargets: [...project.manifest.targets],
    scaffoldIdentity: scaffoldIdentity(project),
    cliIdentity: declaredCliIdentity(project),
    targets: {},
  };
}

function validV1(value: OwnershipState): value is OwnershipStateV1 {
  return value.version === 1 && Boolean(value.files) && typeof value.files === 'object';
}

function validV2(value: OwnershipState): value is OwnershipStateV2 {
  return value.version === 2
    && value.protocolVersion === PROTOCOL_VERSION
    && Boolean(value.targets)
    && typeof value.targets === 'object'
    && Array.isArray(value.manifestTargets);
}

export async function readOwnership(project: ProjectContext): Promise<OwnershipState> {
  const filePath = path.join(project.root, 'xforge', '.state.json');
  let state: OwnershipState | null;
  try {
    state = await readJsonIfExists<OwnershipState>(filePath);
  } catch (error) {
    throw new XForgeError(diagnostic('XFORGE_OWNERSHIP_INVALID', `Ownership state is not valid JSON: ${(error as Error).message}`, OWNERSHIP_PATH), { root: project.root });
  }
  if (!state) return emptyOwnership(project);
  if (!validV1(state) && !validV2(state)) {
    throw new XForgeError(diagnostic('XFORGE_OWNERSHIP_INVALID', 'Ownership state has an unsupported structure.', OWNERSHIP_PATH), { root: project.root });
  }
  return state;
}

function resourceFromLegacy(source: string): { kind: string; id: string } {
  const parts = source.split(':');
  if (parts[0] === 'skill-command') return { kind: 'skill-command', id: parts[1] ?? 'unknown' };
  if (parts[0] === 'builtin') return { kind: 'builtin', id: parts[1] ?? 'bootstrap' };
  return { kind: parts[0] ?? 'unknown', id: parts[1] ?? 'unknown' };
}

function migrateRecord(record: LegacyManagedFileRecord): ManagedFileRecord {
  return {
    source: record.source,
    target: record.target,
    resource: resourceFromLegacy(record.source),
    sources: [],
    renderVersion: 'legacy-v1',
    cliVersion: record.cliVersion,
    protocolVersion: record.protocolVersion,
    desiredDigest: record.digest,
    lastInstalledDigest: record.lastInstalledDigest,
  };
}

export function toOwnershipV2(project: ProjectContext, state: OwnershipState): OwnershipStateV2 {
  if (state.version === 2) return structuredClone(state);
  const targets: OwnershipStateV2['targets'] = {};
  for (const [relative, legacy] of Object.entries(state.files)) {
    const existing = targets[legacy.target] ?? {
      adapterVersion: 'legacy-v1',
      installedAt: state.generatedAt,
      lastUpdatedAt: state.generatedAt,
      lastSyncedAt: null,
      files: {},
    } satisfies TargetInstallationState;
    existing.files[relative] = migrateRecord(legacy);
    targets[legacy.target] = existing;
  }
  return {
    ...emptyOwnership(project, state.generatedAt),
    generatedAt: state.generatedAt,
    targets,
  };
}

export function flattenOwnership(state: OwnershipState): Record<string, LegacyManagedFileRecord | ManagedFileRecord> {
  if (state.version === 1) return { ...state.files };
  const files: Record<string, ManagedFileRecord> = {};
  for (const target of Object.values(state.targets)) {
    if (!target) continue;
    Object.assign(files, target.files);
  }
  return files;
}

export function installedTargets(state: OwnershipState): TargetId[] {
  if (state.version === 1) return [...new Set(Object.values(state.files).map((item) => item.target))].sort();
  return (Object.keys(state.targets) as TargetId[]).filter((target) => Boolean(state.targets[target])).sort();
}

export function installationSummary(state: OwnershipState): Record<string, unknown> {
  const targets = installedTargets(state);
  return {
    recordVersion: state.version,
    targets,
    files: Object.keys(flattenOwnership(state)).length,
    healthy: true,
    lastSyncedAt: state.version === 2
      ? Object.fromEntries(targets.map((target) => [target, state.targets[target]?.lastSyncedAt ?? null]))
      : Object.fromEntries(targets.map((target) => [target, null])),
  };
}

export function targetState(
  project: ProjectContext,
  previous: OwnershipStateV2,
  target: TargetId,
  now: string,
): TargetInstallationState {
  return structuredClone(previous.targets[target] ?? {
    adapterVersion: getAdapter(target).version,
    installedAt: now,
    lastUpdatedAt: now,
    lastSyncedAt: null,
    files: {},
  });
}
