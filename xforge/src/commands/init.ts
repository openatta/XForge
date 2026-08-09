import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import type { Diagnostic, FileChange, NextAction } from '../types.js';
import { loadBundledScaffold, type BundledScaffold } from '../core/bundled-scaffold.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { loadProject } from '../core/project-loader.js';
import { safeResolve } from '../core/path-safety.js';
import { applyManagedTransaction } from '../install/writer.js';
import { executeInstall } from './install.js';

interface InitOptions {
  target?: TargetId;
  dryRun: boolean;
}

interface InitResult {
  data: Record<string, unknown>;
  diagnostics: Diagnostic[];
  changes: FileChange[];
  nextActions: NextAction[];
}

async function exists(filePath: string): Promise<boolean> {
  try { await lstat(filePath); return true; } catch { return false; }
}

async function exactRoot(input: string): Promise<string> {
  const candidate = path.resolve(input);
  let info;
  try { info = await stat(candidate); }
  catch { throw new XForgeError(diagnostic('XFORGE_ROOT_NOT_FOUND', `Project root does not exist: ${candidate}.`)); }
  if (!info.isDirectory()) throw new XForgeError(diagnostic('XFORGE_ROOT_NOT_DIRECTORY', `Project root is not a directory: ${candidate}.`));
  return realpath(candidate);
}

async function planBootstrap(root: string, bundle: BundledScaffold): Promise<{ changes: FileChange[]; diagnostics: Diagnostic[] }> {
  const changes: FileChange[] = [];
  const diagnostics: Diagnostic[] = [];
  const source = `npm:${bundle.package}@${bundle.version}:scaffold`;
  for (const [relative, content] of bundle.files) {
    const destination = await safeResolve(root, relative);
    let info;
    try { info = await lstat(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        changes.push({ action: 'create', path: relative, digest: sha256(content), source });
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      changes.push({ action: 'conflict', path: relative, source, reason: 'Destination is a symlink or non-file.' });
      diagnostics.push(diagnostic('XFORGE_INIT_CONFLICT', 'Bundled Scaffold destination is a symlink or non-file.', relative));
      continue;
    }
    const currentDigest = sha256(await readFile(destination));
    const desiredDigest = sha256(content);
    if (currentDigest === desiredDigest) changes.push({ action: 'skip', path: relative, digest: desiredDigest, source, reason: 'Bundled Scaffold file is already current.' });
    else {
      changes.push({ action: 'conflict', path: relative, digest: currentDigest, source, reason: 'Existing file differs from the bundled Scaffold.' });
      diagnostics.push(diagnostic('XFORGE_INIT_CONFLICT', 'XForge will not overwrite an existing project file during initialization.', relative));
    }
  }
  return { changes, diagnostics };
}

async function materializeBundle(root: string, bundle: BundledScaffold, changes: FileChange[]): Promise<void> {
  const writes = new Map<string, Buffer>();
  for (const change of changes) {
    if (change.action === 'create') writes.set(change.path, bundle.files.get(change.path)!);
  }
  if (writes.size > 0) await applyManagedTransaction({ root }, writes);
}

async function mirrorDestination(actualRoot: string, stagedRoot: string, relative: string): Promise<void> {
  const actual = await safeResolve(actualRoot, relative);
  let info;
  try { info = await lstat(actual); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const staged = await safeResolve(stagedRoot, relative, { createParent: true });
  if (info.isFile() && !info.isSymbolicLink()) await atomicWrite(stagedRoot, relative, await readFile(actual));
  else await mkdir(staged, { recursive: true });
}

async function preflightProjection(root: string, bundle: BundledScaffold, target: TargetId) {
  const stagedRoot = await mkdtemp(path.join(os.tmpdir(), 'xforge-init-'));
  try {
    await materializeBundle(stagedRoot, bundle, [...bundle.files].map(([relative, content]) => ({
      action: 'create' as const,
      path: relative,
      digest: sha256(content),
      source: `npm:${bundle.package}@${bundle.version}:scaffold`,
    })));
    const stagedProject = await loadProject(stagedRoot, { exactRoot: true });
    const initial = await executeInstall(stagedProject, { target, dryRun: true });
    for (const relative of [...new Set(initial.changes.map((change) => change.path))]) {
      if (!bundle.files.has(relative)) await mirrorDestination(root, stagedRoot, relative);
    }
    const mirroredProject = await loadProject(stagedRoot, { exactRoot: true });
    return await executeInstall(mirroredProject, { target, dryRun: true });
  } finally {
    await rm(stagedRoot, { recursive: true, force: true });
  }
}

function nextActions(target?: TargetId): NextAction[] {
  if (target) return [];
  return [{
    action: 'install-target',
    type: 'maintenance',
    status: 'ready',
    reason: 'Project Scaffold is initialized. Project it into one target with --target, or all Manifest targets without --target.',
    command: ['xforge', 'install', '--target', '<target>'],
  }];
}

export async function executeInit(rootInput: string, options: InitOptions): Promise<InitResult> {
  const root = await exactRoot(rootInput);
  const bundle = await loadBundledScaffold();
  const manifestPath = path.join(root, 'xforge', 'manifest.yaml');

  if (await exists(manifestPath)) {
    const project = await loadProject(root, { exactRoot: true });
    if (!options.target) return {
      data: { mode: 'init', dryRun: options.dryRun, initialized: true, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size }, projection: null },
      diagnostics: [],
      changes: [],
      nextActions: nextActions(),
    };
    const projection = await executeInstall(project, { target: options.target, dryRun: options.dryRun });
    return {
      data: { mode: 'init', dryRun: options.dryRun, initialized: true, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size }, projection: projection.data },
      diagnostics: projection.diagnostics,
      changes: projection.changes,
      nextActions: [],
    };
  }

  const bootstrap = await planBootstrap(root, bundle);
  if (bootstrap.diagnostics.some((item) => item.severity === 'error')) return {
    data: { mode: 'init', dryRun: options.dryRun, initialized: false, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size }, projection: null },
    diagnostics: bootstrap.diagnostics,
    changes: bootstrap.changes,
    nextActions: [],
  };

  const projection = options.target ? await preflightProjection(root, bundle, options.target) : null;
  if (projection?.diagnostics.some((item) => item.severity === 'error')) return {
    data: { mode: 'init', dryRun: options.dryRun, initialized: false, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size }, projection: projection.data },
    diagnostics: projection.diagnostics,
    changes: [...bootstrap.changes, ...projection.changes],
    nextActions: [],
  };
  if (options.dryRun) return {
    data: { mode: 'init', dryRun: true, initialized: false, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size }, projection: projection?.data ?? null },
    diagnostics: projection?.diagnostics ?? [],
    changes: [...bootstrap.changes, ...(projection?.changes ?? [])],
    nextActions: nextActions(options.target),
  };

  await materializeBundle(root, bundle, bootstrap.changes);
  if (!options.target) return {
    data: { mode: 'init', dryRun: false, initialized: true, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size }, projection: null },
    diagnostics: [],
    changes: bootstrap.changes,
    nextActions: nextActions(),
  };
  const project = await loadProject(root, { exactRoot: true });
  const installed = await executeInstall(project, { target: options.target, dryRun: false });
  return {
    data: { mode: 'init', dryRun: false, initialized: true, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size }, projection: installed.data },
    diagnostics: installed.diagnostics,
    changes: [...bootstrap.changes, ...installed.changes],
    nextActions: [],
  };
}
