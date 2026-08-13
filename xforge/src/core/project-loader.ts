import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CLI_NAME,
  CLI_VERSION,
  DEFAULT_CHANGES_PATH,
  DEFAULT_SPECS_PATH,
  PROTOCOL_VERSION,
} from '../constants.js';
import type { Compatibility, Diagnostic, FileChange, Lockfile, Manifest, ProjectContext } from '../types.js';
import { readConstitution } from './constitution.js';
import { XForgeError, diagnostic } from './errors.js';
import { atomicWrite } from './files.js';
import { sha256 } from './hash.js';
import { assertLogicalPaths, normalizeRelative, safeResolve } from './path-safety.js';
import { validateSchema } from './validator.js';
import { loadYaml } from './yaml.js';
import { runtimeCliIntegrity } from './identity.js';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(start = process.cwd(), options: { exact?: boolean } = {}): Promise<string> {
  let cursor = path.resolve(start);
  if (options.exact) {
    let info;
    try { info = await stat(cursor); }
    catch {
      throw new XForgeError(diagnostic('XFORGE_ROOT_NOT_FOUND', `Explicit project root does not exist: ${cursor}`));
    }
    if (!info.isDirectory()) throw new XForgeError(diagnostic('XFORGE_ROOT_NOT_DIRECTORY', `Explicit project root is not a directory: ${cursor}`));
    cursor = await realpath(cursor);
    if (await exists(path.join(cursor, 'xforge', 'manifest.yaml'))) return cursor;
    throw new XForgeError(diagnostic('XFORGE_ROOT_NOT_FOUND', `Explicit project root does not contain xforge/manifest.yaml: ${cursor}`));
  }
  while (true) {
    if (await exists(path.join(cursor, 'xforge', 'manifest.yaml'))) return realpath(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new XForgeError(
        diagnostic('XFORGE_PROJECT_NOT_FOUND', 'No xforge/manifest.yaml was found from the current directory upward.'),
        { nextActions: [{ action: 'init', reason: 'Initialize the verified Scaffold bundled with the installed npm package.', command: ['xforge', 'init'] }] },
      );
    }
    cursor = parent;
  }
}

function detectSecrets(value: unknown, filePath: string, prefix = ''): Diagnostic[] {
  if (!value || typeof value !== 'object') return [];
  const diagnostics: Diagnostic[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const property = prefix ? `${prefix}.${key}` : key;
    if (/(?:password|passwd|secret|privateKey|api[_-]?key|access[_-]?token)$/i.test(key) && child !== '' && child != null) {
      diagnostics.push(diagnostic(
        'XFORGE_SECRET_DECLARED',
        `Secret-like field is forbidden in project protocol files: ${property}`,
        filePath,
      ));
    }
    diagnostics.push(...detectSecrets(child, filePath, property));
  }
  return diagnostics;
}

function declaredIdentity(manifest: Manifest): string {
  return `npm:${manifest.xforge.package}@${manifest.xforge.version}`;
}

function actualIdentity(): string {
  return `npm:${CLI_NAME}@${CLI_VERSION}`;
}

function lockCliMatches(manifest: Manifest, lock: Lockfile | null): boolean | null {
  if (!lock?.xforge) return null;
  const locked = lock.xforge;
  if (locked.integrity !== runtimeCliIntegrity()) return false;
  return locked.source === 'npm' && locked.package === manifest.xforge.package && locked.version === manifest.xforge.version && locked.protocol === manifest.xforge.protocol;
}

export function resolveCompatibility(manifest: Manifest, lock: Lockfile | null): { value: Compatibility; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const protocolMatches = manifest.xforge.protocol === PROTOCOL_VERSION;
  let cliMatches = false;

  cliMatches = manifest.xforge.package === CLI_NAME && manifest.xforge.version === CLI_VERSION;

  if (!protocolMatches) {
    diagnostics.push(diagnostic('XFORGE_PROTOCOL_MISMATCH', `Project protocol ${manifest.xforge.protocol} does not match running protocol ${PROTOCOL_VERSION}.`, 'xforge/manifest.yaml'));
  }
  if (!cliMatches) {
    diagnostics.push(diagnostic(
      'XFORGE_CLI_IDENTITY_MISMATCH',
      `Declared CLI ${declaredIdentity(manifest)} does not match running CLI ${actualIdentity()}.`,
      'xforge/manifest.yaml',
    ));
  }

  const lockedCliMatches = lockCliMatches(manifest, lock);
  if (lockedCliMatches === false) {
    diagnostics.push(diagnostic('XFORGE_LOCK_CLI_MISMATCH', 'Lockfile CLI identity differs from the Manifest.', 'xforge/lock.yaml'));
  }
  if (lock?.protocol && lock.protocol !== PROTOCOL_VERSION) {
    diagnostics.push(diagnostic('XFORGE_LOCK_PROTOCOL_MISMATCH', 'Lockfile protocol differs from the running protocol.', 'xforge/lock.yaml'));
  }

  const lockedScaffold = typeof lock?.scaffold?.version === 'string' ? lock.scaffold.version : null;
  const scaffoldMatches = lockedScaffold === null ? null : lockedScaffold === manifest.scaffold.version;
  if (scaffoldMatches === false) {
    diagnostics.push(diagnostic('XFORGE_LOCK_SCAFFOLD_MISMATCH', 'Lockfile Scaffold version differs from the Manifest.', 'xforge/lock.yaml', 'warning'));
  }
  const lockedLanguage = typeof lock?.scaffold?.language === 'string' ? lock.scaffold.language : null;
  if (lockedLanguage !== null && lockedLanguage !== manifest.scaffold.language) {
    diagnostics.push(diagnostic('XFORGE_LOCK_LANGUAGE_MISMATCH', 'Lockfile Scaffold language differs from the Manifest.', 'xforge/lock.yaml'));
  }

  const managed = protocolMatches && cliMatches && lockedCliMatches !== false && (lockedLanguage === null || lockedLanguage === manifest.scaffold.language);
  return {
    value: {
      mode: managed ? 'managed' : 'portable',
        cli: { declared: declaredIdentity(manifest), actual: actualIdentity(), matches: cliMatches },
      protocol: { declared: manifest.xforge.protocol, actual: PROTOCOL_VERSION, matches: protocolMatches },
      scaffold: { declared: manifest.scaffold.version, locked: lockedScaffold, matches: scaffoldMatches },
    },
    diagnostics,
  };
}

export async function loadProject(start = process.cwd(), options: { exactRoot?: boolean } = {}): Promise<ProjectContext> {
  const root = await findProjectRoot(start, { exact: options.exactRoot });
  const manifestPath = path.join(root, 'xforge', 'manifest.yaml');
  const manifest = await loadYaml<Manifest>(manifestPath, 'xforge/manifest.yaml');
  const schemaDiagnostics = await validateSchema('manifest', manifest, 'xforge/manifest.yaml');
  if (schemaDiagnostics.some((item) => item.severity === 'error')) {
    throw new XForgeError(schemaDiagnostics, { root });
  }

  const specsPath = normalizeRelative(manifest.project.paths?.specs ?? DEFAULT_SPECS_PATH, 'project.paths.specs');
  const changesPath = normalizeRelative(manifest.project.paths?.changes ?? DEFAULT_CHANGES_PATH, 'project.paths.changes');
  assertLogicalPaths(specsPath, changesPath);
  await safeResolve(root, specsPath);
  await safeResolve(root, changesPath);

  const moduleIds = new Set<string>();
  for (const module of manifest.project.modules) {
    if (moduleIds.has(module.id)) {
      throw new XForgeError(diagnostic('XFORGE_MODULE_DUPLICATE', `Duplicate module ID: ${module.id}`, 'xforge/manifest.yaml'), { root });
    }
    moduleIds.add(module.id);
    await safeResolve(root, normalizeRelative(module.path, `module ${module.id}`));
  }

  const lockPath = path.join(root, 'xforge', 'lock.yaml');
  const lock = await exists(lockPath) ? await loadYaml<Lockfile>(lockPath, 'xforge/lock.yaml') : null;
  const lockDiagnostics = lock ? await validateSchema('lock', lock, 'xforge/lock.yaml') : [
    diagnostic('XFORGE_LOCK_MISSING', 'xforge/lock.yaml is required for reproducible Managed operation.', 'xforge/lock.yaml'),
  ];
  if (lockDiagnostics.some((item) => item.severity === 'error')) {
    throw new XForgeError(lockDiagnostics, { root });
  }
  const { constitution, diagnostics: constitutionDiagnostics } = await readConstitution(root, manifest.scaffold?.language);
  const compatibility = resolveCompatibility(manifest, lock);
  const diagnostics = [
    ...schemaDiagnostics,
    ...lockDiagnostics,
    ...constitutionDiagnostics,
    ...compatibility.diagnostics,
    ...detectSecrets(manifest, 'xforge/manifest.yaml'),
    ...detectSecrets(lock, 'xforge/lock.yaml'),
  ];

  if (lock?.paths) {
    const lockedSpecs = lock.paths.specs ? normalizeRelative(lock.paths.specs) : null;
    const lockedChanges = lock.paths.changes ? normalizeRelative(lock.paths.changes) : null;
    if (lockedSpecs !== specsPath || lockedChanges !== changesPath) {
      diagnostics.push(diagnostic('XFORGE_LOCK_PATHS_MISMATCH', 'Lockfile logical paths differ from the Manifest resolution.', 'xforge/lock.yaml', 'warning'));
    }
  }

  return {
    root,
    manifestPath,
    manifest,
    lockPath,
    lock,
    specsPath,
    changesPath,
    specsPathSource: manifest.project.paths?.specs ? 'manifest' : 'default',
    changesPathSource: manifest.project.paths?.changes ? 'manifest' : 'default',
    constitution,
    compatibility: compatibility.value,
    diagnostics,
  };
}

/**
 * Parses a `major.minor.patch[-prerelease]` string, as `scripts/prepare-release.mjs` does. Splits
 * at the *first* `-` and keeps the whole remainder as the prerelease, so a prerelease that itself
 * contains a hyphen (`0.8.0-rc-1`) is not silently truncated to a prefix that compares equal to
 * its siblings.
 */
function parseVersion(value: string): { core: number[]; prerelease: string } {
  const separator = value.indexOf('-');
  const core = separator === -1 ? value : value.slice(0, separator);
  return { core: core.split('.').map((part) => Number(part)), prerelease: separator === -1 ? '' : value.slice(separator + 1) };
}

/**
 * Three-way compare, `< 0` when `left` is older than `right`.
 *
 * A version without a prerelease outranks an otherwise-equal version with one, matching standard
 * SemVer precedence — so `0.8.0-rc.1 < 0.8.0`, and reconciling an rc pin up to its GA release is
 * correctly seen as an upgrade while the reverse is correctly seen as a downgrade. Two differing
 * prereleases are compared with numeric collation (`rc.2 < rc.10`, not the plain lexical order
 * that would invert them), exactly as `scripts/prepare-release.mjs` compares the versions it
 * stamps. Numeric collation is not a full SemVer §11 identifier-by-identifier comparison, but it
 * agrees with it on every prerelease shape this project publishes, and — unlike a lexical or
 * dot-segment compare — it cannot report an *older* running CLI as newer, which is the mistake
 * that would turn this upgrade channel into a silent downgrade.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

/**
 * Whether `xforge update` may reconcile the Manifest's declared CLI identity to the running CLI's
 * identity, instead of hard-blocking with no resolution path.
 *
 * Deliberately narrow: this is an *upgrade* channel, not a general "make the mismatch go away"
 * escape hatch. It refuses whenever the situation isn't a clean, safe upgrade:
 * - the declared package must already be `@xforge/cli` from npm (not some other/legacy source);
 * - the Protocol must already match (`XFORGE_PROTOCOL_MISMATCH` is a structural incompatibility,
 *   not a version lag — reconciling the version number would not make the CLI actually understand
 *   a different Protocol's on-disk shapes, so this stays a hard block, unresolved by this feature);
 * - the declared version must be strictly older than the running CLI's version — never equal
 *   (nothing to do) and never newer (that would silently declare a "downgrade" as resolved, which
 *   is exactly the silent-state-corruption failure mode the exact-version lock exists to prevent);
 * - `manifest.scaffold.version` and `manifest.scaffold.source.version` must already agree with
 *   `manifest.xforge.version` — if a project's three version fields have already drifted from each
 *   other (not something any XForge command produces today), that is an unexpected hand-edited or
 *   corrupted state this feature does not attempt to guess how to reconcile.
 *
 * Prereleases are deliberately *not* excluded. A prerelease CLI reconciles a project just like a
 * GA one, in both directions of the boundary (`0.7.9-rc.1 -> 0.7.9`, `0.7.8 -> 0.7.9-rc.1`), for
 * two reasons: `compareVersions` orders prereleases correctly, so none of the guarantees above
 * weaken; and refusing here would only move the dead end this feature exists to remove — a project
 * pinned by a prerelease CLI would have no in-tool way back. That requires all three version
 * fields to *accept* a prerelease, which is why `manifest.schema.json` shares one `semver` $def
 * across `xforge.version`, `scaffold.version`, and `scaffold.source.version` rather than letting
 * `scaffold.version` keep a narrower pattern: `reconcileDeclaredCliVersion` writes the identical
 * string into all three, so a field that rejects what the other two accept would make the very
 * Manifest this function just wrote fail `loadProject`'s schema validation on the next command.
 */
export function canUpgradeDeclaredCli(manifest: Manifest): boolean {
  if (manifest.xforge.source !== 'npm' || manifest.xforge.package !== CLI_NAME) return false;
  if (manifest.xforge.protocol !== PROTOCOL_VERSION) return false;
  if (manifest.scaffold.version !== manifest.xforge.version) return false;
  if (manifest.scaffold.source.type !== 'npm' || manifest.scaffold.source.package !== CLI_NAME) return false;
  if (manifest.scaffold.source.version !== manifest.xforge.version) return false;
  return compareVersions(manifest.xforge.version, CLI_VERSION) < 0;
}

/**
 * Rewrites the three npm-version fields a Manifest uses to declare its pinned CLI/Scaffold
 * identity (`xforge.version`, `scaffold.version`, `scaffold.source.version` — all required to
 * already agree, see `canUpgradeDeclaredCli`) from the declared version to the running CLI's
 * version, in place on disk, then mutates `project.manifest`/`project.compatibility` so the rest
 * of this same command invocation sees a consistent, already-Managed project.
 *
 * Uses targeted, context-anchored text substitution rather than a full YAML parse-and-restringify
 * round trip, so anything else in a hand-edited `manifest.yaml` — comments, key order, formatting
 * — survives untouched. Mirrors `scripts/prepare-release.mjs`'s own approach to editing this
 * repository's bundled manifest at release time. If the file's shape doesn't match what
 * `canUpgradeDeclaredCli` already validated structurally (should not happen — defensive only),
 * this fails loudly instead of silently leaving one of the three fields stale.
 *
 * A no-op (returns `[]`, touches nothing) when `canUpgradeDeclaredCli` is false — including the
 * ordinary case where the project is already Managed and there is nothing to reconcile.
 */
/**
 * Replaces a direct-child `fieldName: value` line inside the block that follows a `blockKey:`
 * header line at `blockIndent`, without touching anything outside that block or any more-deeply-
 * nested field of the same name (e.g. `scaffold.version` vs. `scaffold.source.version`). Key
 * *order* inside the block does not matter — only its indentation depth — so this survives a
 * round trip through a YAML formatter/library that reorders keys but preserves nesting depth
 * (e.g. this codebase's own test helpers, or a user's editor). Returns `null`, changing nothing,
 * if the block or the field within it isn't found in the expected shape.
 */
function replaceFieldInBlock(text: string, blockKey: string, blockIndent: number, fieldName: string, fieldIndent: number, value: string): string | null {
  const blockPattern = new RegExp(`^${' '.repeat(blockIndent)}${blockKey}:\\n((?:${' '.repeat(fieldIndent)}[^\\n]*\\n?)*)`, 'm');
  const blockMatch = blockPattern.exec(text);
  if (!blockMatch) return null;
  const fieldPattern = new RegExp(`^${' '.repeat(fieldIndent)}${fieldName}: [^\\n]+`, 'm');
  if (!fieldPattern.test(blockMatch[1]!)) return null;
  const newBody = blockMatch[1]!.replace(fieldPattern, `${' '.repeat(fieldIndent)}${fieldName}: ${value}`);
  return text.slice(0, blockMatch.index) + `${' '.repeat(blockIndent)}${blockKey}:\n${newBody}` + text.slice(blockMatch.index + blockMatch[0].length);
}

export async function reconcileDeclaredCliVersion(project: ProjectContext, dryRun: boolean): Promise<FileChange[]> {
  if (!canUpgradeDeclaredCli(project.manifest)) return [];
  const from = project.manifest.xforge.version;
  const to = CLI_VERSION;
  const source = await readFile(project.manifestPath, 'utf8');
  let next = source;
  const scaffoldFixed = replaceFieldInBlock(next, 'scaffold', 0, 'version', 2, to);
  if (scaffoldFixed === null) {
    throw new XForgeError(diagnostic(
      'XFORGE_MANIFEST_VERSION_FIELD_NOT_FOUND',
      'Could not locate scaffold.version in xforge/manifest.yaml in the expected shape to reconcile the declared CLI version. Edit it by hand instead.',
      'xforge/manifest.yaml',
    ), { root: project.root });
  }
  next = scaffoldFixed;
  const sourceFixed = replaceFieldInBlock(next, 'source', 2, 'version', 4, to);
  if (sourceFixed === null) {
    throw new XForgeError(diagnostic(
      'XFORGE_MANIFEST_VERSION_FIELD_NOT_FOUND',
      'Could not locate scaffold.source.version in xforge/manifest.yaml in the expected shape to reconcile the declared CLI version. Edit it by hand instead.',
      'xforge/manifest.yaml',
    ), { root: project.root });
  }
  next = sourceFixed;
  const xforgeFixed = replaceFieldInBlock(next, 'xforge', 0, 'version', 2, to);
  if (xforgeFixed === null) {
    throw new XForgeError(diagnostic(
      'XFORGE_MANIFEST_VERSION_FIELD_NOT_FOUND',
      'Could not locate xforge.version in xforge/manifest.yaml in the expected shape to reconcile the declared CLI version. Edit it by hand instead.',
      'xforge/manifest.yaml',
    ), { root: project.root });
  }
  next = xforgeFixed;
  if (!dryRun) await atomicWrite(project.root, 'xforge/manifest.yaml', next);
  project.manifest.xforge.version = to;
  project.manifest.scaffold.version = to;
  project.manifest.scaffold.source.version = to;
  const recomputed = resolveCompatibility(project.manifest, project.lock);
  project.compatibility = recomputed.value;
  /*
   * `project.diagnostics` (unlike `project.compatibility`) is a plain snapshot computed once in
   * `loadProject`, before this reconciliation ran — `checkStructure`/`state-reader` both start
   * their own diagnostics from `[...project.diagnostics]` unconditionally, so a stale
   * `XFORGE_CLI_IDENTITY_MISMATCH`/`XFORGE_LOCK_CLI_MISMATCH`/etc. from the pre-reconciliation
   * Manifest would otherwise still fail the command even though the mismatch it names no longer
   * exists. Splice in the freshly recomputed compatibility diagnostics in place of the stale ones.
   */
  const compatibilityCodes = new Set([
    'XFORGE_PROTOCOL_MISMATCH', 'XFORGE_CLI_IDENTITY_MISMATCH', 'XFORGE_LOCK_CLI_MISMATCH',
    'XFORGE_LOCK_PROTOCOL_MISMATCH', 'XFORGE_LOCK_SCAFFOLD_MISMATCH', 'XFORGE_LOCK_LANGUAGE_MISMATCH',
  ]);
  project.diagnostics = [...project.diagnostics.filter((item) => !compatibilityCodes.has(item.code)), ...recomputed.diagnostics];
  return [{
    action: 'modify',
    path: 'xforge/manifest.yaml',
    digest: sha256(next),
    source: `xforge:declared-version-upgrade:${from}->${to}`,
  }];
}

export function assertManaged(project: ProjectContext, command: string): void {
  if (project.compatibility.mode === 'managed') return;
  const compatibilityErrors = project.diagnostics.filter((item) => [
    'XFORGE_PROTOCOL_MISMATCH',
    'XFORGE_CLI_IDENTITY_MISMATCH',
    'XFORGE_LOCK_CLI_MISMATCH',
    'XFORGE_LOCK_PROTOCOL_MISMATCH',
  ].includes(item.code));
  const upgradable = canUpgradeDeclaredCli(project.manifest);
  throw new XForgeError(
    compatibilityErrors.length > 0 ? compatibilityErrors : diagnostic('XFORGE_MANAGED_REQUIRED', `${command} requires Managed mode.`),
    {
      root: project.root,
      nextActions: upgradable
        ? [{ action: 'resolve-declared-xforge', reason: `The declared CLI version (${project.manifest.xforge.version}) is older than the running CLI (${CLI_VERSION}) and the Protocol matches — run xforge update to reconcile the declared version, rather than installing an older CLI.`, command: ['xforge', 'update'] }]
        : [{ action: 'resolve-declared-xforge', reason: 'Install the exact @xforge/cli npm version declared by the project.' }],
    },
  );
}

export function assertUpdateCompatible(project: ProjectContext): void {
  if (project.compatibility.cli.matches && project.compatibility.protocol.matches) return;
  assertManaged(project, 'update');
}
