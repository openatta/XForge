import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import { CLI_VERSION, PROTOCOL_VERSION } from '../constants.js';
import { getAdapter } from '../adapters/index.js';
import { PROJECTED_DIMENSIONS, type ProjectionDimension } from '../adapters/capabilities.js';
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
import { localizedVariant } from '../core/language.js';
import {
  FragmentParseError,
  adoptWholeFileAsFragment,
  applyFragment,
  fragmentDigest,
  fragmentDrifted,
  removeFragment,
  type Fragment,
} from './fragments.js';
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

async function localizedSourceFiles(
  directory: string,
  language: ProjectContext['manifest']['scaffold']['language'],
): Promise<Array<{ relative: string; sourceRelative: string; content: Buffer }>> {
  const files = await sourceFiles(directory);
  const byRelative = new Map(files.map((file) => [file.relative, file]));
  const defaults = files.filter((file) => !/_cn(?=\.[^/]+$)/.test(file.relative));
  return defaults.map((file) => {
    const variant = localizedVariant(file.relative);
    const selected = language === 'zh-CN' ? byRelative.get(variant) ?? file : file;
    return { relative: file.relative, sourceRelative: selected.relative, content: selected.content };
  });
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

/**
 * Cross-checks the selection against what each Adapter *declares* it can do.
 *
 * `AdapterCapability` used to be read-only decoration echoed by `state` and `install`: nothing
 * compared it against the resources being projected, so an unsupported Hook event was dropped by a
 * bare `continue` and a policy the host cannot express simply never appeared. This is where the
 * README's "reporting capability gaps instead of pretending the platforms are equal" is enforced.
 */
export function capabilityGapDiagnostics(resources: SelectedResources, targets: TargetId[]): Diagnostic[] {
  const result: Diagnostic[] = [];
  for (const target of targets) {
    const { capability } = getAdapter(target);
    for (const [id, hook] of resources.hooks) {
      if (!hook.value.spec.enabled || (hook.value.spec.plane ?? 'runtime') !== 'runtime') continue;
      if (capability.runtimeHook.events.includes(hook.value.spec.event)) continue;
      result.push(diagnostic(
        'XFORGE_HOOK_EVENT_UNSUPPORTED',
        `Target ${target} does not expose Hook event ${hook.value.spec.event}; Hook ${id} is not projected for that target.`,
        hook.yamlPath,
        'warning',
        { target, hook: id, event: hook.value.spec.event, supportedEvents: capability.runtimeHook.events },
      ));
    }
    const scopes = capability.permissionPolicyScopes;
    if (!scopes) continue;
    for (const [id, policy] of resources.policies) {
      const spec = policy.value.spec;
      const usesExceptActors = Boolean(spec.exceptActors?.length);
      const usesStages = Boolean(spec.match.stages?.length);
      if (!usesExceptActors && !usesStages) continue;

      // "This target has no static rule for capability C" is a structural, unchanging property of
      // the target, fully declared in `capability.permissionPolicyScopes` and echoed by `install`
      // and `state`. Repeating it as a per-install diagnostic on every run would train readers to
      // ignore the stream; what is reported here is the situational loss — a policy the target
      // would otherwise have carried, dropped because of a dimension it cannot express.
      //
      // Targets whose `permissionPolicyScopes.capabilities` is empty (Cursor, Copilot today) never
      // reach that "would otherwise have carried it" precondition for any capability, so without an
      // explicit branch here a policy using `exceptActors`/`match.stages` gets no diagnostic at all
      // on those targets — silence that reads as "this policy is fine here" when in fact there is no
      // static projection to have withheld anything from in the first place. State that plainly
      // instead of leaving it to be inferred from an absence.
      if (!scopes.capabilities.includes(spec.capability)) {
        result.push(diagnostic(
          'XFORGE_POLICY_STATIC_LAYER_DEGRADED',
          `Target ${target} has no static permission-policy projection at all, so PermissionPolicy ${id} (which uses exceptActors/match.stages) is enforced only by the XForge runtime Hook bridge.`,
          policy.yamlPath,
          'info',
          { target, policy: id, capability: spec.capability, reason: 'no-static-projection' },
        ));
        continue;
      }

      const unexpressible = [
        ...(usesExceptActors && !scopes.actorScoped ? ['exceptActors'] : []),
        ...(usesStages && !scopes.stageScoped ? ['match.stages'] : []),
      ];
      if (unexpressible.length === 0) continue;
      result.push(diagnostic(
        'XFORGE_POLICY_STATIC_LAYER_DEGRADED',
        `Target ${target} cannot express ${unexpressible.join(' or ')} in its static permission layer, so PermissionPolicy ${id} is withheld from it and enforced only by the XForge runtime Hook bridge.`,
        policy.yamlPath,
        'warning',
        { target, policy: id, unexpressible },
      ));
    }
  }
  return result;
}

interface DroppedResource { id: string; path: string }

const DIMENSION_GAP: Record<ProjectionDimension, { kind: string; gap: string }> = {
  commands: { kind: 'Skill', gap: 'does not project Skill command files; these Skills install without a command entry point' },
  rules: { kind: 'Rule', gap: 'does not project rule files; these Rules are not installed for that target' },
  agents: { kind: 'Agent', gap: 'does not project agent files; these Agents are not installed for that target' },
};

/**
 * Turns the resources an Adapter declined to project into diagnostics, one summary per target and
 * dimension rather than one per resource: with five targets the per-resource form put seventeen
 * notes into the stream of every install, sync and update, which teaches readers to skip the
 * stream. `details.resources` still names every affected resource and its source path.
 *
 * The choice of code comes from `PROJECTED_DIMENSIONS`, not from guessing why the Adapter returned
 * null. When the table says the target cannot express the dimension, the drop is a structural
 * property of the target and worth an `info` note — `info` deliberately, because `projection.ts`
 * refuses to apply the whole plan when any diagnostic is an `error`, so anything louder than a
 * warning here would make install impossible for every Codex or OpenCode project. When the table
 * declares support and the Adapter produced nothing anyway, the two disagree and one of them must
 * be fixed: that is a `warning`, and is unreachable with today's adapters.
 */
function capabilityDropDiagnostics(target: TargetId, dropped: Record<ProjectionDimension, DroppedResource[]>): Diagnostic[] {
  const result: Diagnostic[] = [];
  for (const dimension of Object.keys(DIMENSION_GAP) as ProjectionDimension[]) {
    const resources = dropped[dimension];
    if (resources.length === 0) continue;
    const { kind, gap } = DIMENSION_GAP[dimension];
    const names = resources.map((item) => item.id).join(', ');
    const details = { target, dimension, kind, count: resources.length, resources };
    result.push(PROJECTED_DIMENSIONS[target][dimension]
      ? diagnostic(
        'XFORGE_ADAPTER_PROJECTION_MISSING',
        `Adapter for ${target} produced no ${dimension} output for ${resources.length} resource(s) (${names}) although the capability table declares support for that dimension; the table and the adapter disagree and one of them must be fixed.`,
        undefined,
        'warning',
        details,
      )
      : diagnostic(
        'XFORGE_CAPABILITY_CONTENT_UNSUPPORTED',
        `Target ${target} ${gap}: ${names}.`,
        undefined,
        'info',
        details,
      ));
  }
  return result;
}

async function buildDesired(
  project: ProjectContext,
  resources: SelectedResources,
  targets: TargetId[],
): Promise<{ desired: Map<string, DesiredFile>; diagnostics: Diagnostic[] }> {
  const desired = new Map<string, DesiredFile>();
  const diagnostics = capabilityGapDiagnostics(resources, targets);
  for (const target of targets) {
    const adapter = getAdapter(target);
    const dropped: Record<ProjectionDimension, DroppedResource[]> = { commands: [], rules: [], agents: [] };
    for (const bootstrap of adapter.bootstrap()) addDesired(desired, bootstrap);

    for (const [id, directory] of resources.skills) {
      for (const file of await localizedSourceFiles(directory, project.manifest.scaffold.language)) {
        const sourcePath = `xforge/scaffold/skills/${id}/${file.sourceRelative}`;
        addDesired(desired, {
          path: `${adapter.skillDirectory(id)}/${file.relative}`,
          content: file.content,
          source: `skill:${id}:${file.sourceRelative}`,
          target,
          ...adapter.trace('skill', id, [sourcePath]),
        });
      }
      // One local, used for both the trace and the diagnostic: on a zh-CN project the Skill
      // document that exists on disk is the localized variant, so naming plain `SKILL.md` in the
      // diagnostic pointed operators at a file that is not there.
      const skillDocPath = `xforge/scaffold/skills/${id}/${project.manifest.scaffold.language === 'zh-CN' ? localizedVariant('SKILL.md') : 'SKILL.md'}`;
      const commandPath = adapter.commandPath(id);
      const commandContent = adapter.renderCommand(id);
      if (commandPath && commandContent != null) addDesired(desired, {
        path: commandPath,
        content: Buffer.from(commandContent),
        source: `skill-command:${id}`,
        target,
        ...adapter.trace('skill-command', id, [skillDocPath]),
      });
      else dropped.commands.push({ id, path: skillDocPath });
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
      // `yamlPath` is the language-independent `<id>.yaml`, so unlike the Skill document above it
      // needs no zh-CN variant resolution.
      else dropped.agents.push({ id, path: agent.yamlPath });
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
      else dropped.rules.push({ id, path: rule.yamlPath });
    }
    diagnostics.push(...capabilityDropDiagnostics(target, dropped));
    const governance = adapter.renderGovernance({
      policies: [...resources.policies].map(([id, item]) => ({ id, ...item })),
      hooks: [...resources.hooks].map(([id, item]) => ({ id, ...item })),
    });
    for (const file of governance.files) addDesired(desired, file);
    diagnostics.push(...governance.diagnostics);
  }

  if (resources.mcpServers.size > 0) {
    // Deliberate: `McpServer` defines an XForge approval channel (`core/mcp-approval.ts`), not an
    // MCP server for the coding tool to orchestrate. Its fields (`authTokenEnv`, `timeoutSeconds`)
    // have no counterpart in `.mcp.json`, and projecting it would take over another file a team
    // owns. Rather than project a misleading config, the limited semantics are stated out loud.
    for (const [id, server] of resources.mcpServers) {
      diagnostics.push(diagnostic(
        'XFORGE_MCP_SERVER_NOT_PROJECTED',
        `McpServer ${id} defines an XForge approval channel and is not projected as a coding-tool MCP configuration; configure the server in the host's own MCP config (for example .mcp.json) if agents should call its tools.`,
        server.yamlPath,
        'info',
        { server: id, usedBy: 'approvals' },
      ));
    }
  }
  return { desired, diagnostics };
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

async function currentText(project: ProjectContext, relative: string): Promise<string | null> {
  const absolute = await safeResolve(project.root, relative);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return await readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

interface FragmentPlan {
  /** Full file content to write: XForge's material merged into everything the user owns. */
  merged: string;
  /** Digest of the owned material only, so unrelated user edits never churn the record. */
  ownedDigest: string;
  /** The user removed or rewrote material XForge previously installed. */
  drifted: boolean;
  /** The destination exists but cannot be parsed in the fragment's format. */
  parseError: string | null;
}

/**
 * Resolves every partially-owned destination before planning, so the rest of the planner works on
 * final content. Also migrates records written under whole-file ownership: when the destination
 * still matches the recorded whole-file digest, everything at the owned locations was XForge's and
 * is adopted as the fragment baseline without prompting the user.
 */
async function planFragments(
  project: ProjectContext,
  desired: Map<string, DesiredFile>,
  previous: OwnershipStateV2,
): Promise<Map<string, FragmentPlan>> {
  const result = new Map<string, FragmentPlan>();
  for (const file of desired.values()) {
    if (!file.fragment) continue;
    const text = await currentText(project, file.path);
    const old = previous.targets[file.target]?.files[file.path];
    let recorded: Fragment | null = old?.fragment ?? null;
    let drifted = false;
    try {
      if (old && !recorded) {
        if (text !== null && sha256(Buffer.from(text)) === old.lastInstalledDigest) recorded = adoptWholeFileAsFragment(text, file.fragment, file.path);
        else drifted = true;
      } else if (old && recorded) {
        drifted = fragmentDrifted(text, recorded, file.path);
      }
      const merged = applyFragment(text, file.fragment, recorded, file.path);
      file.content = Buffer.from(merged);
      result.set(file.path, { merged, ownedDigest: fragmentDigest(file.fragment), drifted, parseError: null });
    } catch (error) {
      if (!(error instanceof FragmentParseError)) throw error;
      result.set(file.path, { merged: text ?? '', ownedDigest: fragmentDigest(file.fragment), drifted, parseError: error.message });
    }
  }
  return result;
}

/** Only XForge's own material is scanned; a user's unrelated keys are not XForge's to police. */
function scannedContent(file: DesiredFile): Buffer {
  if (!file.fragment) return file.content;
  return Buffer.from(file.fragment.format === 'markers' ? file.fragment.body : stableStringify({ arrays: file.fragment.arrays ?? [], values: file.fragment.values ?? [] }));
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
  const built = await buildDesired(project, resources, targets);
  const desired = built.desired;
  const previousV2 = toOwnershipV2(project, previous);
  const next = structuredClone(previousV2);
  const diagnostics = [...resources.diagnostics, ...built.diagnostics];
  const changes: FileChange[] = [];
  const now = new Date().toISOString();
  const fragments = await planFragments(project, desired, previousV2);

  for (const file of desired.values()) {
    if (hasSecretLikeContent(scannedContent(file))) diagnostics.push(diagnostic(
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
      const fragmentPlan = fragments.get(relative);
      // For a partially-owned file the record tracks the owned material, not the whole file, so an
      // edit to a key XForge does not own never marks the record dirty.
      const desiredDigest = fragmentPlan ? fragmentPlan.ownedDigest : sha256(file.content);
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
        ...(file.fragment ? { fragment: file.fragment } : {}),
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
      if (fragmentPlan) {
        if (fragmentPlan.parseError) {
          changes.push({ action: 'conflict', path: relative, digest: current?.digest, source: file.source, target: file.target, reason: fragmentPlan.parseError });
          diagnostics.push(diagnostic('XFORGE_INSTALL_CONFLICT', `Partially managed destination cannot be parsed: ${fragmentPlan.parseError}`, relative));
          continue;
        }
        if (fragmentPlan.drifted) {
          changes.push({ action: 'conflict', path: relative, digest: current?.digest, source: file.source, target: file.target, reason: 'XForge-owned keys were modified after installation.' });
          diagnostics.push(diagnostic('XFORGE_MANAGED_FILE_MODIFIED', 'XForge-owned keys in a partially managed destination were modified after installation.', relative));
          continue;
        }
        const mergedDigest = sha256(Buffer.from(fragmentPlan.merged));
        if (!current) changes.push({ action: 'create', path: relative, digest: mergedDigest, source: file.source, target: file.target });
        else if (current.digest === mergedDigest) changes.push({ action: 'skip', path: relative, digest: mergedDigest, source: file.source, target: file.target, reason: 'Already current.' });
        else changes.push({ action: 'modify', path: relative, digest: mergedDigest, source: file.source, target: file.target });
        working.files[relative] = record;
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
      if (owned.fragment && !current.symlink) {
        // Retract only XForge's own material; the file survives if the user has anything in it.
        const text = await currentText(project, relative);
        let remainder: string | null = null;
        try {
          if (text === null || fragmentDrifted(text, owned.fragment, relative)) throw new FragmentParseError('XForge-owned keys were modified after installation.');
          remainder = removeFragment(text, owned.fragment, relative);
        } catch (error) {
          if (!(error instanceof FragmentParseError)) throw error;
          changes.push({ action: 'conflict', path: relative, digest: current.digest, source: owned.source, target: owned.target, reason: (error as Error).message });
          diagnostics.push(diagnostic('XFORGE_MANAGED_FILE_MODIFIED', 'Modified partially managed file cannot be reverted by managed-only pruning.', relative));
          continue;
        }
        if (remainder === null) changes.push({ action: 'delete', path: relative, digest: current.digest, source: owned.source, target: owned.target });
        else {
          // The writer resolves content from `desired`, so publish the retracted file there.
          desired.set(relative, {
            path: relative, content: Buffer.from(remainder), source: owned.source, target: owned.target,
            resource: owned.resource, sourcePaths: [], renderVersion: owned.renderVersion,
          });
          changes.push({ action: 'modify', path: relative, digest: sha256(Buffer.from(remainder)), source: owned.source, target: owned.target });
        }
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
