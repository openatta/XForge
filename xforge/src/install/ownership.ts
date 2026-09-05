import { access } from 'node:fs/promises';
import path from 'node:path';
import type {
  LegacyManagedFileRecord,
  ManagedFileRecord,
  NextAction,
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

/**
 * The installation record: which files each target owns, and the digest each was installed at.
 *
 * Named `.install.json` and not `.state.json`, which is what it was called until a measured run
 * showed what that name costs. `xforge state` is the command an Agent reaches for when it wants to
 * know where a Change stands; `xforge/.state.json` is a 165KB digest map with no bearing on that
 * question. A live Clarify Stage opened it and paid 67,901 bytes -- about 17k tokens, the largest
 * single input of that Stage -- for a file whose entire content was irrelevant to what it asked.
 *
 * The two names cannot both be right, and this is the one that moves: the command is in every Skill
 * and every projected rule, and the file is a cache nobody reads on purpose.
 */
export const OWNERSHIP_PATH = 'xforge/.install.json';

/**
 * Where the record lived before, still read and still cleaned up.
 *
 * A rename that only changed the writer would report `XFORGE_NOT_INSTALLED` on every installed
 * project at the first command after upgrading -- the record would be right there on disk under the
 * name nothing looked for any more. So the reader falls back to it, and the next write removes it,
 * which makes the migration a side effect of the first `install`/`sync`/`update` rather than a step
 * anybody has to take.
 */
export const LEGACY_OWNERSHIP_PATH = 'xforge/.state.json';

export function manifestSelectionDigest(project: ProjectContext): string {
  return sha256(stableStringify({
    scaffold: {
      skills: project.manifest.scaffold.skills,
      agents: project.manifest.scaffold.agents,
      language: project.manifest.scaffold.language,
      rules: project.manifest.scaffold.rules,
      hooks: project.manifest.scaffold.hooks,
      gates: project.manifest.scaffold.gates,
    },
    scripts: project.manifest.scripts ?? [],
  }));
}

export function scaffoldIdentity(project: ProjectContext): string {
  return sha256(stableStringify({ version: project.manifest.scaffold.version, source: project.manifest.scaffold.source, language: project.manifest.scaffold.language }));
}

export function declaredCliIdentity(project: ProjectContext): string {
  return sha256(stableStringify(project.manifest.xforge));
}

function emptyOwnership(project: ProjectContext, now = new Date(0).toISOString()): OwnershipStateV2 {
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

/*
 * The one recovery, attached to both refusals.
 *
 * The record is machine-generated, 165KB, carries a per-file digest map for every installed
 * target, and is rewritten in full by every `install` -- so two developers who each ran `install`
 * on their own branch produce a merge conflict in it as a matter of course. Conflicted, it stops
 * being JSON, and `state`, `install`, `sync` and `update` all die here at the first read.
 *
 * Deleting it and reinstalling has always worked: the file is a cache of what `install` wrote, and
 * `install` can write it again from the Scaffold and the Manifest. Nothing said so. A live merge
 * left the CLI refusing every command with `Next actions: []`, `explain` returning the interpolated
 * template, and `doctor` -- the one tool whose job is to say what is wrong -- reporting unused
 * Flows and not mentioning the ownership state at all.
 */
function ownershipRecovery(): NextAction[] {
  return [{
    action: 'rebuild-ownership-state',
    type: 'maintenance',
    actor: 'main',
    status: 'ready',
    inputs: [OWNERSHIP_PATH],
    writes: [OWNERSHIP_PATH],
    doneWhen: [`${OWNERSHIP_PATH} is valid JSON again and every managed file is accounted for.`],
    requiredEvidence: ['xforge state resolves the project.'],
    reason: `${OWNERSHIP_PATH} is generated by install and can be rebuilt from the Scaffold and the Manifest; nothing in it is authored.`,
    command: ['xforge', 'install'],
  }];
}

/** Absolute path of the record, or of the legacy record when only that one is on disk. */
export async function ownershipFilePath(project: Pick<ProjectContext, 'root'>): Promise<string> {
  const current = path.join(project.root, ...OWNERSHIP_PATH.split('/'));
  const legacy = path.join(project.root, ...LEGACY_OWNERSHIP_PATH.split('/'));
  try {
    await access(current);
    return current;
  } catch {
    /* Not "the record is missing" -- an uninstalled project has neither, and returning the current
       name for that case is what makes `readJsonIfExists` answer null against the right path. */
  }
  try {
    await access(legacy);
    return legacy;
  } catch {
    return current;
  }
}

/** Whether a pre-rename record is still on disk, so a write can remove it in the same transaction. */
export async function legacyOwnershipPresent(project: Pick<ProjectContext, 'root'>): Promise<boolean> {
  try {
    await access(path.join(project.root, ...LEGACY_OWNERSHIP_PATH.split('/')));
    return true;
  } catch {
    return false;
  }
}

export async function readOwnership(project: ProjectContext): Promise<OwnershipState> {
  const filePath = await ownershipFilePath(project);
  let state: OwnershipState | null;
  try {
    state = await readJsonIfExists<OwnershipState>(filePath);
  } catch (error) {
    throw new XForgeError(diagnostic('XFORGE_OWNERSHIP_INVALID', `Ownership state is not valid JSON: ${(error as Error).message}. This file is generated by install, so it is rebuilt rather than repaired: delete it and run install. A Git merge conflict in it is the usual cause -- it is rewritten in full by every install, so two branches that both installed conflict here as a matter of course.`, OWNERSHIP_PATH), { root: project.root, nextActions: ownershipRecovery() });
  }
  if (!state) return emptyOwnership(project);
  if (!validV1(state) && !validV2(state)) {
    throw new XForgeError(diagnostic('XFORGE_OWNERSHIP_INVALID', 'Ownership state has an unsupported structure. This file is generated by install, so it is rebuilt rather than repaired: delete it and run install.', OWNERSHIP_PATH), { root: project.root, nextActions: ownershipRecovery() });
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

function flattenOwnership(state: OwnershipState): Record<string, LegacyManagedFileRecord | ManagedFileRecord> {
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
