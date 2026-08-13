import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CLI_NAME,
  CLI_VERSION,
  DEFAULT_CHANGES_PATH,
  DEFAULT_SPECS_PATH,
  PROTOCOL_VERSION,
} from '../constants.js';
import type { Compatibility, Diagnostic, Lockfile, Manifest, ProjectContext } from '../types.js';
import { readConstitution } from './constitution.js';
import { XForgeError, diagnostic } from './errors.js';
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

function resolveCompatibility(manifest: Manifest, lock: Lockfile | null): { value: Compatibility; diagnostics: Diagnostic[] } {
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

export function assertManaged(project: ProjectContext, command: string): void {
  if (project.compatibility.mode === 'managed') return;
  const compatibilityErrors = project.diagnostics.filter((item) => [
    'XFORGE_PROTOCOL_MISMATCH',
    'XFORGE_CLI_IDENTITY_MISMATCH',
    'XFORGE_LOCK_CLI_MISMATCH',
    'XFORGE_LOCK_PROTOCOL_MISMATCH',
  ].includes(item.code));
  throw new XForgeError(
    compatibilityErrors.length > 0 ? compatibilityErrors : diagnostic('XFORGE_MANAGED_REQUIRED', `${command} requires Managed mode.`),
    {
      root: project.root,
      nextActions: updateUpgradeAvailable(project)
        ? [{ action: 'run-upgrade', reason: 'The running CLI is newer than the declared version; xforge update will lift this project to it.', command: ['xforge', 'update'] }]
        : [{ action: 'resolve-declared-xforge', reason: 'Install the exact @xforge/cli npm version declared by the project.' }],
    },
  );
}

/**
 * Dot-separated version comparison. Segments that both parse as numbers compare numerically
 * (`9` < `10`); anything else compares lexically; a missing segment equals `''`. Returns -1/0/1.
 */
export function compareVersions(left: string, right: string): number {
  const l = left.split('.');
  const r = right.split('.');
  for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
    const ls = l[i] ?? '';
    const rs = r[i] ?? '';
    const ln = Number(ls);
    const rn = Number(rs);
    if (!Number.isNaN(ln) && !Number.isNaN(rn) && ln !== rn) return ln < rn ? -1 : 1;
    if (ls !== rs) return ls < rs ? -1 : 1;
  }
  return 0;
}

/**
 * True when `xforge update` may lift this project to the running CLI's identity: the protocols
 * match and the running CLI is strictly newer than the declared one. A newer declaration stays
 * hard-blocked (downgrading must never happen silently).
 */
export function updateUpgradeAvailable(project: ProjectContext): boolean {
  return project.compatibility.protocol.matches
    && !project.compatibility.cli.matches
    && compareVersions(CLI_VERSION, project.manifest.xforge.version) > 0;
}

export function assertUpdateCompatible(project: ProjectContext): void {
  if (project.compatibility.cli.matches && project.compatibility.protocol.matches) return;
  if (updateUpgradeAvailable(project)) return;
  assertManaged(project, 'update');
}

/**
 * The project as it will look once an upgrade rewrites the declared CLI identity to the running
 * one. Used by `update` for planning (both dry-run and real) without mutating the caller's view.
 * The bundled-Scaffold consistency precondition is enforced separately by `loadBundledScaffold`.
 */
export function upgradedProjectContext(project: ProjectContext): ProjectContext {
  const manifest = {
    ...project.manifest,
    xforge: { source: 'npm' as const, package: CLI_NAME as '@xforge/cli', version: CLI_VERSION, protocol: PROTOCOL_VERSION as '1' | '2' },
    scaffold: {
      ...project.manifest.scaffold,
      version: CLI_VERSION,
      source: { ...project.manifest.scaffold.source, version: CLI_VERSION },
    },
  };
  const compatibility = resolveCompatibility(manifest, project.lock);
  const diagnostics = [
    ...project.diagnostics.filter((item) => !['XFORGE_CLI_IDENTITY_MISMATCH', 'XFORGE_LOCK_CLI_MISMATCH'].includes(item.code)),
    ...compatibility.diagnostics.filter((item) => !['XFORGE_LOCK_CLI_MISMATCH', 'XFORGE_LOCK_PROTOCOL_MISMATCH'].includes(item.code)),
  ];
  return { ...project, manifest, compatibility: compatibility.value, diagnostics };
}
