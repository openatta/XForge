import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import { CLI_VERSION, PROTOCOL_VERSION } from '../constants.js';
import { getAdapter } from '../adapters/index.js';
import type {
  DesiredFile,
  Diagnostic,
  FileChange,
  ManagedFileRecord,
  OwnershipState,
  OwnershipStateV2,
  ProjectContext,
  SourceFingerprint,
} from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { sha256, stableStringify } from '../core/hash.js';
import { safeResolve } from '../core/path-safety.js';
import { loadSelectedResources, type SelectedResources } from '../core/resource-loader.js';
import {
  declaredCliIdentity,
  flattenOwnership,
  installedTargets,
  manifestSelectionDigest,
  readOwnership,
  scaffoldIdentity,
  targetState,
  toOwnershipV2,
} from './ownership.js';

export type ProjectionMode = 'install' | 'sync' | 'update';

async function sourceFiles(directory: string, prefix = ''): Promise<Array<{ relative: string; content: Buffer }>> {
  const result: Array<{ relative: string; content: Buffer }> = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new XForgeError(diagnostic('XFORGE_RESOURCE_SYMLINK_FORBIDDEN', 'Symlinks are forbidden inside installable resources.', relative));
    }
    if (stat.isDirectory()) result.push(...await sourceFiles(absolute, relative));
    else if (stat.isFile()) result.push({ relative, content: await readFile(absolute) });
  }
  return result;
}

function addDesired(map: Map<string, DesiredFile>, file: DesiredFile): void {
  const existing = map.get(file.path);
  if (existing && (!existing.content.equals(file.content) || existing.source !== file.source)) {
    throw new XForgeError(diagnostic(
      'XFORGE_GENERATED_PATH_COLLISION',
      `Multiple resources generate different content for ${file.path}.`,
      file.path,
      'error',
      { sources: [existing.source, file.source] },
    ));
  }
  map.set(file.path, file);
}

async function buildDesired(
  project: ProjectContext,
  resources: SelectedResources,
  targets: TargetId[],
): Promise<Map<string, DesiredFile>> {
  const desired = new Map<string, DesiredFile>();
  for (const target of targets) {
    const adapter = getAdapter(target);
    for (const bootstrap of adapter.bootstrap()) addDesired(desired, bootstrap);

    for (const [id, directory] of resources.skills) {
      for (const file of await sourceFiles(directory)) {
        const sourcePath = `xforge/scaffold/skills/${id}/${file.relative}`;
        addDesired(desired, {
          path: `${adapter.skillDirectory(id)}/${file.relative}`,
          content: file.content,
          source: `skill:${id}:${file.relative}`,
          target,
          ...adapter.trace('skill', id, [sourcePath]),
        });
      }
      const commandPath = adapter.commandPath(id);
      const commandContent = adapter.renderCommand(id);
      if (commandPath && commandContent != null) addDesired(desired, {
        path: commandPath,
        content: Buffer.from(commandContent),
        source: `skill-command:${id}`,
        target,
        ...adapter.trace('skill-command', id, [`xforge/scaffold/skills/${id}/SKILL.md`]),
      });
    }

    for (const [id, agent] of resources.agents) {
      const outputPath = adapter.agentPath(id);
      const output = adapter.renderAgent(agent.value, agent.instructions);
      if (outputPath && output != null) addDesired(desired, {
        path: outputPath,
        content: Buffer.from(output),
        source: `agent:${id}`,
        target,
        ...adapter.trace('agent', id, [agent.yamlPath, agent.instructionsPath]),
      });
    }

    for (const [id, rule] of resources.rules) {
      const outputPath = adapter.rulePath(id);
      const output = adapter.renderRule(rule.value);
      if (outputPath && output != null) addDesired(desired, {
        path: outputPath,
        content: Buffer.from(output),
        source: `rule:${id}`,
        target,
        ...adapter.trace('rule', id, [rule.yamlPath]),
      });
    }
  }
  return desired;
}

async function currentFile(project: ProjectContext, relative: string): Promise<{ digest: string; symlink: boolean } | null> {
  const absolute = await safeResolve(project.root, relative);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return { digest: '', symlink: true };
    return { digest: sha256(await readFile(absolute)), symlink: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function hasSecretLikeContent(content: Buffer): boolean {
  const text = content.toString('utf8');
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /\bAKIA[0-9A-Z]{16}\b/.test(text)
    || /\b(?:password|passwd|secret|api[_-]?key|(?:access[_-]?)?token)\s*[:=]\s*(?!\[REDACTED\]|<[^>]+>|\$\{)["']?[A-Za-z0-9_+\-/=.]{8,}/i.test(text);
}

function sameStrings(left: string[], right: string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function priorSourceMap(state: OwnershipStateV2, scopeTargets: TargetId[]): Map<string, SourceFingerprint> {
  const result = new Map<string, SourceFingerprint>();
  for (const target of scopeTargets) {
    for (const record of Object.values(state.targets[target]?.files ?? {})) {
      for (const source of record.sources) if (!result.has(source.path)) result.set(source.path, source);
    }
  }
  return result;
}

async function fingerprint(
  project: ProjectContext,
  relative: string,
  previous: SourceFingerprint | undefined,
  verifyDigests: boolean,
): Promise<SourceFingerprint> {
  const absolute = await safeResolve(project.root, relative);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new XForgeError(diagnostic('XFORGE_SOURCE_MISSING', 'Adapter source must be a regular project file.', relative), { root: project.root });
  }
  const digest = !verifyDigests && previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size
    ? previous.digest
    : sha256(await readFile(absolute));
  return { path: relative, mtimeMs: stat.mtimeMs, size: stat.size, digest };
}

function sourceChanged(previous: SourceFingerprint | undefined, current: SourceFingerprint): boolean {
  return !previous
    || previous.mtimeMs !== current.mtimeMs
    || previous.size !== current.size
    || previous.digest !== current.digest;
}

export interface ProjectionStats {
  scannedSources: number;
  changedSources: number;
  renderedFiles: number;
  recordOnly: number;
}

export interface InstallPlan {
  mode: ProjectionMode;
  resources: SelectedResources;
  targets: TargetId[];
  scopeTargets: TargetId[];
  desired: Map<string, DesiredFile>;
  previous: OwnershipState;
  next: OwnershipStateV2;
  stateChanged: boolean;
  changes: FileChange[];
  diagnostics: Diagnostic[];
  stats: ProjectionStats;
}

export interface ProjectionOptions {
  mode: ProjectionMode;
  target?: TargetId;
  verifyDigests?: boolean;
}

function notInstalled(project: ProjectContext, command: ProjectionMode): never {
  throw new XForgeError(diagnostic('XFORGE_NOT_INSTALLED', `${command} requires an existing installation record.`, 'xforge/.state.json'), {
    root: project.root,
    nextActions: [{ action: 'install', reason: 'Create the initial managed installation record.', command: ['xforge', 'install', '--dry-run'] }],
  });
}

function assertSyncIdentity(project: ProjectContext, state: OwnershipStateV2): void {
  const targets = installedTargets(state);
  const adapterMismatch = targets.some((target) => state.targets[target]?.adapterVersion !== getAdapter(target).version);
  const removedInstalledTarget = targets.some((target) => !project.manifest.targets.includes(target));
  if (!sameStrings(state.manifestTargets, project.manifest.targets)
    || state.scaffoldIdentity !== scaffoldIdentity(project)
    || state.cliIdentity !== declaredCliIdentity(project)
    || adapterMismatch
    || removedInstalledTarget) {
    throw new XForgeError(diagnostic(
      'XFORGE_FULL_UPDATE_REQUIRED',
      'Target, Scaffold, CLI, or Adapter identity changed; run a full update before sync.',
      'xforge/.state.json',
    ), {
      root: project.root,
      nextActions: [{ action: 'update', reason: 'Reconcile full installation identity.', command: ['xforge', 'update', '--dry-run'] }],
    });
  }
}

function resolveTargets(project: ProjectContext, previous: OwnershipState, options: ProjectionOptions): { targets: TargetId[]; scopeTargets: TargetId[] } {
  const installed = installedTargets(previous);
  if (options.mode !== 'install' && installed.length === 0) notInstalled(project, options.mode);

  if (options.mode === 'sync') {
    if (previous.version === 1) {
      throw new XForgeError(diagnostic('XFORGE_STATE_UPGRADE_REQUIRED', 'sync requires installation record version 2.', 'xforge/.state.json'), {
        root: project.root,
        nextActions: [{ action: 'update', reason: 'Upgrade and fully reconcile the installation record.', command: ['xforge', 'update', '--dry-run'] }],
      });
    }
    assertSyncIdentity(project, previous);
    if (options.target && !installed.includes(options.target)) {
      throw new XForgeError(diagnostic('XFORGE_TARGET_NOT_INSTALLED', `Target is not installed: ${options.target}`, 'xforge/.state.json'), { root: project.root });
    }
    const targets = options.target ? [options.target] : installed.filter((target) => project.manifest.targets.includes(target));
    return { targets, scopeTargets: targets };
  }

  if (options.target && !project.manifest.targets.includes(options.target)) {
    throw new XForgeError(diagnostic('XFORGE_TARGET_NOT_ENABLED', `Target is not enabled by the Manifest: ${options.target}`, 'xforge/manifest.yaml'), { root: project.root });
  }
  const targets = options.target ? [options.target] : [...project.manifest.targets];
  const scopeTargets = options.mode === 'update' && !options.target
    ? [...new Set([...installed, ...targets])]
    : targets;
  return { targets, scopeTargets };
}

export async function planProjection(project: ProjectContext, options: ProjectionOptions): Promise<InstallPlan> {
  const previous = await readOwnership(project);
  const { targets, scopeTargets } = resolveTargets(project, previous, options);
  const resources = await loadSelectedResources(project);
  const desired = await buildDesired(project, resources, targets);
  const previousV2 = toOwnershipV2(project, previous);
  const next = structuredClone(previousV2);
  const diagnostics = [...resources.diagnostics];
  const changes: FileChange[] = [];
  const now = new Date().toISOString();

  for (const file of desired.values()) {
    if (hasSecretLikeContent(file.content)) diagnostics.push(diagnostic(
      'XFORGE_SECRET_IN_GENERATED_CONTENT',
      'Secret-like material is forbidden in generated Adapter files.',
      file.path,
    ));
  }

  const priorSources = priorSourceMap(previousV2, scopeTargets);
  const fingerprints = new Map<string, SourceFingerprint>();
  for (const sourcePath of [...new Set([...desired.values()].flatMap((file) => file.sourcePaths))].sort()) {
    fingerprints.set(sourcePath, await fingerprint(project, sourcePath, priorSources.get(sourcePath), options.mode !== 'sync' || options.verifyDigests === true));
  }
  if (options.mode === 'sync' && options.verifyDigests !== true) {
    for (const file of desired.values()) {
      const old = previousV2.targets[file.target]?.files[file.path];
      if (!old || old.desiredDigest === sha256(file.content)) continue;
      for (const sourcePath of file.sourcePaths) {
        const previousSource = priorSources.get(sourcePath);
        const currentSource = fingerprints.get(sourcePath);
        if (!previousSource || !currentSource) continue;
        if (previousSource.mtimeMs === currentSource.mtimeMs
          && previousSource.size === currentSource.size
          && previousSource.digest === currentSource.digest) {
          fingerprints.set(sourcePath, await fingerprint(project, sourcePath, previousSource, true));
        }
      }
    }
  }
  const changedSourcePaths = new Set<string>();
  for (const [sourcePath, current] of fingerprints) {
    if (sourceChanged(priorSources.get(sourcePath), current)) changedSourcePaths.add(sourcePath);
  }
  for (const sourcePath of priorSources.keys()) if (!fingerprints.has(sourcePath)) changedSourcePaths.add(sourcePath);

  const desiredByTarget = new Map<TargetId, Map<string, DesiredFile>>();
  for (const target of targets) desiredByTarget.set(target, new Map());
  for (const [relative, file] of desired) desiredByTarget.get(file.target)?.set(relative, file);

  let renderedFiles = 0;
  for (const target of scopeTargets) {
    const active = targets.includes(target);
    const beforeTarget = previousV2.targets[target];
    const working = targetState(project, next, target, now);
    const beforeFiles = stableStringify(working.files);
    const targetDesired = desiredByTarget.get(target) ?? new Map<string, DesiredFile>();

    for (const [relative, file] of [...targetDesired].sort(([left], [right]) => left.localeCompare(right))) {
      const old = working.files[relative];
      const desiredDigest = sha256(file.content);
      const sources = file.sourcePaths
        .map((sourcePath) => fingerprints.get(sourcePath))
        .filter((item): item is SourceFingerprint => Boolean(item))
        .map((item) => ({ ...item }));
      const record: ManagedFileRecord = {
        source: file.source,
        target: file.target,
        resource: file.resource,
        sources,
        renderVersion: file.renderVersion,
        cliVersion: CLI_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        desiredDigest,
        lastInstalledDigest: desiredDigest,
      };
      if (!old
        || old.renderVersion !== file.renderVersion
        || old.desiredDigest !== desiredDigest
        || file.sourcePaths.some((sourcePath) => changedSourcePaths.has(sourcePath))) renderedFiles += 1;

      const current = await currentFile(project, relative);
      if (current?.symlink) {
        changes.push({ action: 'conflict', path: relative, source: file.source, target: file.target, reason: 'Destination is a symlink or non-file.' });
        diagnostics.push(diagnostic('XFORGE_INSTALL_CONFLICT', 'Generated destination is a symlink or non-file.', relative));
        continue;
      }
      if (!current) {
        changes.push({ action: 'create', path: relative, digest: desiredDigest, source: file.source, target: file.target });
        working.files[relative] = record;
        continue;
      }
      if (!old) {
        changes.push({ action: 'conflict', path: relative, digest: current.digest, source: file.source, target: file.target, reason: 'Existing file is not XForge-managed.' });
        diagnostics.push(diagnostic('XFORGE_INSTALL_CONFLICT', 'Existing destination is not owned by XForge.', relative));
        continue;
      }
      if (current.digest !== old.lastInstalledDigest) {
        changes.push({ action: 'conflict', path: relative, digest: current.digest, source: file.source, target: file.target, reason: 'Managed file was modified after installation.' });
        diagnostics.push(diagnostic('XFORGE_MANAGED_FILE_MODIFIED', 'Managed destination differs from its last installed digest.', relative));
        continue;
      }
      if (current.digest === desiredDigest) changes.push({ action: 'skip', path: relative, digest: desiredDigest, source: file.source, target: file.target, reason: 'Already current.' });
      else changes.push({ action: 'modify', path: relative, digest: desiredDigest, source: file.source, target: file.target });
      working.files[relative] = record;
    }

    for (const [relative, owned] of Object.entries(working.files).sort(([left], [right]) => left.localeCompare(right))) {
      if (targetDesired.has(relative)) continue;
      const current = await currentFile(project, relative);
      if (!current) {
        delete working.files[relative];
        continue;
      }
      if (current.symlink || current.digest !== owned.lastInstalledDigest) {
        changes.push({ action: 'conflict', path: relative, digest: current.digest, source: owned.source, target: owned.target, reason: 'Disabled managed file was modified and cannot be pruned.' });
        diagnostics.push(diagnostic('XFORGE_MANAGED_FILE_MODIFIED', 'Modified managed file cannot be removed by managed-only pruning.', relative));
        continue;
      }
      changes.push({ action: 'delete', path: relative, digest: current.digest, source: owned.source, target: owned.target });
      delete working.files[relative];
    }

    working.adapterVersion = getAdapter(target).version;
    const targetChanged = beforeFiles !== stableStringify(working.files)
      || beforeTarget?.adapterVersion !== working.adapterVersion;
    if (targetChanged) {
      if (options.mode === 'sync') working.lastSyncedAt = now;
      else working.lastUpdatedAt = now;
    }
    if (!active && Object.keys(working.files).length === 0) delete next.targets[target];
    else next.targets[target] = working;
  }

  next.protocolVersion = PROTOCOL_VERSION;
  next.manifestSelectionDigest = manifestSelectionDigest(project);
  next.manifestTargets = [...project.manifest.targets];
  next.scaffoldIdentity = scaffoldIdentity(project);
  next.cliIdentity = declaredCliIdentity(project);
  const beforeState = stableStringify({ ...previousV2, generatedAt: '' });
  const afterState = stableStringify({ ...next, generatedAt: '' });
  const stateChanged = previous.version === 1 || beforeState !== afterState;
  if (stateChanged) next.generatedAt = now;

  const actionable = changes.some((item) => ['create', 'modify', 'delete'].includes(item.action));
  return {
    mode: options.mode,
    resources,
    targets,
    scopeTargets,
    desired,
    previous,
    next,
    stateChanged,
    changes,
    diagnostics,
    stats: {
      scannedSources: fingerprints.size,
      changedSources: changedSourcePaths.size,
      renderedFiles,
      recordOnly: stateChanged && !actionable ? 1 : 0,
    },
  };
}

export async function planInstall(project: ProjectContext, target?: TargetId): Promise<InstallPlan> {
  return planProjection(project, { mode: 'install', target });
}
