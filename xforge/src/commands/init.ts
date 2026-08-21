import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TargetId } from '../constants.js';
import type { Diagnostic, FileChange, NextAction, ScaffoldLanguage } from '../types.js';
import { loadBundledScaffold, type BundledScaffold } from '../core/bundled-scaffold.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { sha256 } from '../core/hash.js';
import { localizedVariant } from '../core/language.js';
import { loadProject } from '../core/project-loader.js';
import { safeResolve } from '../core/path-safety.js';
import { applyManagedTransaction } from '../install/writer.js';
import { executeInstall } from './install.js';

interface InitOptions {
  target?: TargetId;
  language?: ScaffoldLanguage;
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

/**
 * Documents the Agent reads that live at the `xforge/` root, shipped as an English default plus an
 * optional `_cn` variant. Skills already collapse to one file per project at install time; these
 * did not, so a zh-CN project got both and the canonical name held the English text — a reader
 * opening `xforge/constitution.md` reasonably concluded there was no Chinese version, and an edit
 * to the file they were looking at did nothing.
 */
/*
 * Flows join the Constitution and XFORGE.md here because a Flow is half prose.
 *
 * `outline` names the `## ` sections an Artifact should have, and `markers[].section` locates one
 * of them *by that heading's exact text*. Left in English under `--language zh-CN`, that obliged a
 * Chinese document to carry English subheadings or lose every marker — and an author writing the
 * document naturally wrote Chinese ones and silently resolved nothing. The `_cn` variants translate
 * the two together, and `flow-localization.test.ts` holds them to differing in nothing else.
 *
 * Flows are init-time assets: they install to `xforge/flows/`, which `upgrade-scaffold` does not
 * touch (it reads `xforge/scaffold/` only). So this reaches new projects and leaves the Flow files
 * of existing ones alone — which is what keeps it from restating every in-flight Change's
 * contentRevision, since that digests the Flow file's bytes.
 */
const COLLAPSED_DOCUMENTS = [
  'xforge/constitution.md', 'xforge/XFORGE.md',
  'xforge/flows/quick.yaml', 'xforge/flows/solid.yaml', 'xforge/flows/major.yaml',
];

function pinBundleLanguage(bundle: BundledScaffold, language: ScaffoldLanguage): BundledScaffold {
  const files = new Map(bundle.files);
  for (const relative of ['xforge/manifest.yaml', 'xforge/lock.yaml']) {
    const content = files.get(relative);
    if (!content) throw new XForgeError(diagnostic('XFORGE_BUNDLED_SCAFFOLD_INVALID', `Bundled Scaffold is missing ${relative}.`, relative));
    const source = content.toString('utf8');
    const localized = source.replace(/^(  language:) (?:en|zh-CN)$/m, `$1 ${language}`);
    if (localized === source && !source.includes(`  language: ${language}`)) {
      throw new XForgeError(diagnostic('XFORGE_BUNDLED_SCAFFOLD_INVALID', `Bundled Scaffold cannot pin language in ${relative}.`, relative));
    }
    files.set(relative, Buffer.from(localized));
  }
  /*
   * Collapse to exactly one file under the canonical name, the way `install` already does for
   * Skills. The `_cn` source never lands in a project: a project has one language, so a second
   * copy in the other one is a file nobody maintains and everybody has to reason about.
   */
  for (const relative of COLLAPSED_DOCUMENTS) {
    const localizedRelative = localizedVariant(relative);
    const localized = files.get(localizedRelative);
    if (!localized) continue;
    if (language === 'zh-CN') files.set(relative, localized);
    files.delete(localizedRelative);
  }
  return { ...bundle, files };
}

async function exactRoot(input: string): Promise<string> {
  const candidate = path.resolve(input);
  let info;
  try { info = await stat(candidate); }
  catch { throw new XForgeError(diagnostic('XFORGE_ROOT_NOT_FOUND', `Project root does not exist: ${candidate}.`)); }
  if (!info.isDirectory()) throw new XForgeError(diagnostic('XFORGE_ROOT_NOT_DIRECTORY', `Project root is not a directory: ${candidate}.`));
  return realpath(candidate);
}

/**
 * Files XForge co-owns with the project instead of owning outright. Every repository that already
 * talks to Codex / Cursor / Copilot ships its own `AGENTS.md`, so a whole-file digest comparison
 * would make `init` impossible in exactly the repositories XForge targets. These files are merged
 * through a marker block: everything between the markers belongs to XForge, everything outside is
 * preserved byte-for-byte.
 */
const MERGE_FILES = new Set(['AGENTS.md']);
const MERGE_BEGIN = '<!-- XFORGE:BEGIN -->';
const MERGE_END = '<!-- XFORGE:END -->';

interface MarkerBlock {
  before: string;
  block: string;
  after: string;
}

/**
 * Locates the single XForge marker block. Returns `null` when the text carries no marker at all
 * (a plain project-owned file the block gets appended to) and `'malformed'` when the markers are
 * present but unusable — unbalanced, reversed, or duplicated. Malformed markers are the one case
 * that stays a conflict: guessing which half of an ambiguous file XForge owns would destroy
 * project content.
 */
function locateMarkerBlock(text: string): MarkerBlock | null | 'malformed' {
  const begins: number[] = [];
  const ends: number[] = [];
  for (let index = text.indexOf(MERGE_BEGIN); index !== -1; index = text.indexOf(MERGE_BEGIN, index + 1)) begins.push(index);
  for (let index = text.indexOf(MERGE_END); index !== -1; index = text.indexOf(MERGE_END, index + 1)) ends.push(index);
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1) return 'malformed';
  const begin = begins[0]!;
  const end = ends[0]!;
  if (end < begin) return 'malformed';
  return { before: text.slice(0, begin), block: text.slice(begin, end + MERGE_END.length), after: text.slice(end + MERGE_END.length) };
}

/** The bundled Scaffold copy is authoritative for the block body, markers included. */
function bundledBlock(relative: string, content: Buffer): string {
  const located = locateMarkerBlock(content.toString('utf8'));
  if (located === null || located === 'malformed') {
    throw new XForgeError(diagnostic('XFORGE_BUNDLED_SCAFFOLD_INVALID', `Bundled Scaffold file ${relative} is missing a well-formed XForge marker block.`, relative));
  }
  return located.block;
}

function mergeMarkerBlock(existing: string, block: string): string | 'malformed' {
  const located = locateMarkerBlock(existing);
  if (located === 'malformed') return 'malformed';
  if (located) return `${located.before}${block}${located.after}`;
  if (existing.length === 0) return `${block}\n`;
  return `${existing}${existing.endsWith('\n') ? '' : '\n'}\n${block}\n`;
}

async function planBootstrap(root: string, bundle: BundledScaffold): Promise<{ changes: FileChange[]; diagnostics: Diagnostic[]; writes: Map<string, Buffer> }> {
  const changes: FileChange[] = [];
  const diagnostics: Diagnostic[] = [];
  const writes = new Map<string, Buffer>();
  const source = `npm:${bundle.package}@${bundle.version}:scaffold`;
  for (const [relative, content] of bundle.files) {
    const merged = MERGE_FILES.has(relative);
    const destination = await safeResolve(root, relative);
    let info;
    try { info = await lstat(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        changes.push({ action: 'create', path: relative, digest: sha256(content), source });
        writes.set(relative, content);
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      changes.push({ action: 'conflict', path: relative, source, reason: 'Destination is a symlink or non-file.' });
      diagnostics.push(diagnostic('XFORGE_INIT_CONFLICT', 'Bundled Scaffold destination is a symlink or non-file.', relative));
      continue;
    }
    const current = await readFile(destination);
    const currentDigest = sha256(current);
    if (!merged) {
      const desiredDigest = sha256(content);
      if (currentDigest === desiredDigest) changes.push({ action: 'skip', path: relative, digest: desiredDigest, source, reason: 'Bundled Scaffold file is already current.' });
      else {
        changes.push({ action: 'conflict', path: relative, digest: currentDigest, source, reason: 'Existing file differs from the bundled Scaffold.' });
        diagnostics.push(diagnostic('XFORGE_INIT_CONFLICT', 'XForge will not overwrite an existing project file during initialization.', relative));
      }
      continue;
    }
    const desired = mergeMarkerBlock(current.toString('utf8'), bundledBlock(relative, content));
    if (desired === 'malformed') {
      changes.push({ action: 'conflict', path: relative, digest: currentDigest, source, reason: `Existing file has unbalanced ${MERGE_BEGIN} / ${MERGE_END} markers.` });
      diagnostics.push(diagnostic('XFORGE_INIT_CONFLICT', `XForge cannot merge its managed block into a file with unbalanced ${MERGE_BEGIN} / ${MERGE_END} markers. Repair or remove the markers, then re-run init.`, relative));
      continue;
    }
    const desiredContent = Buffer.from(desired, 'utf8');
    const desiredDigest = sha256(desiredContent);
    if (currentDigest === desiredDigest) {
      changes.push({ action: 'skip', path: relative, digest: desiredDigest, source, reason: 'Managed XForge block is already current.' });
      continue;
    }
    changes.push({ action: 'modify', path: relative, digest: desiredDigest, source, reason: 'Merged the managed XForge block; content outside the markers is preserved.' });
    writes.set(relative, desiredContent);
  }
  return { changes, diagnostics, writes };
}

async function materializeBundle(root: string, writes: Map<string, Buffer>): Promise<void> {
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
    await materializeBundle(stagedRoot, new Map(bundle.files));
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
  const bundled = await loadBundledScaffold();
  const manifestPath = path.join(root, 'xforge', 'manifest.yaml');

  if (await exists(manifestPath)) {
    const project = await loadProject(root, { exactRoot: true });
    if (!options.target) return {
      data: { mode: 'init', dryRun: options.dryRun, initialized: true, scaffold: { package: bundled.package, version: bundled.version, files: bundled.files.size, language: project.manifest.scaffold.language }, projection: null },
      diagnostics: [],
      changes: [],
      nextActions: nextActions(),
    };
    const projection = await executeInstall(project, { target: options.target, dryRun: options.dryRun });
    return {
      data: { mode: 'init', dryRun: options.dryRun, initialized: true, scaffold: { package: bundled.package, version: bundled.version, files: bundled.files.size, language: project.manifest.scaffold.language }, projection: projection.data },
      diagnostics: projection.diagnostics,
      changes: projection.changes,
      nextActions: [],
    };
  }

  if (!options.language) throw new XForgeError(diagnostic('XFORGE_LANGUAGE_REQUIRED', 'A resolved Scaffold language is required for initialization.'));
  const bundle = pinBundleLanguage(bundled, options.language);

  const bootstrap = await planBootstrap(root, bundle);
  if (bootstrap.diagnostics.some((item) => item.severity === 'error')) return {
    data: { mode: 'init', dryRun: options.dryRun, initialized: false, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size, language: options.language }, projection: null },
    diagnostics: bootstrap.diagnostics,
    changes: bootstrap.changes,
    nextActions: [],
  };

  const projection = options.target ? await preflightProjection(root, bundle, options.target) : null;
  if (projection?.diagnostics.some((item) => item.severity === 'error')) return {
    data: { mode: 'init', dryRun: options.dryRun, initialized: false, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size, language: options.language }, projection: projection.data },
    diagnostics: projection.diagnostics,
    changes: [...bootstrap.changes, ...projection.changes],
    nextActions: [],
  };
  if (options.dryRun) return {
    data: { mode: 'init', dryRun: true, initialized: false, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size, language: options.language }, projection: projection?.data ?? null },
    diagnostics: projection?.diagnostics ?? [],
    changes: [...bootstrap.changes, ...(projection?.changes ?? [])],
    nextActions: nextActions(options.target),
  };

  await materializeBundle(root, bootstrap.writes);
  if (!options.target) return {
    data: { mode: 'init', dryRun: false, initialized: true, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size, language: options.language }, projection: null },
    diagnostics: [],
    changes: bootstrap.changes,
    nextActions: nextActions(),
  };
  const project = await loadProject(root, { exactRoot: true });
  const installed = await executeInstall(project, { target: options.target, dryRun: false });
  return {
    data: { mode: 'init', dryRun: false, initialized: true, scaffold: { package: bundle.package, version: bundle.version, files: bundle.files.size, language: options.language }, projection: installed.data },
    diagnostics: installed.diagnostics,
    changes: [...bootstrap.changes, ...installed.changes],
    nextActions: [],
  };
}
