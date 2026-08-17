import { access } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectContext } from '../types.js';
import { safeResolve } from './path-safety.js';

/**
 * Recognising a project's build system well enough to *suggest* a verification command.
 *
 * Read the limits first, because they are the design rather than a caveat:
 *
 * - **This table is incomplete and always will be.** New languages appear, projects use in-house
 *   build scripts, and no list here can keep up.
 * - **That costs nothing.** A detected marker only enriches the question XForge asks; it never
 *   decides anything. An unrecognised project is still asked, just without a suggestion, and an
 *   undeclared Gate still refuses. The failure mode this replaces was the opposite one: the CLI
 *   knew only npm, and answered "I don't recognise this project" with `passed`.
 * - **Nothing here is ever written to disk automatically.** A suggestion reaches the user through a
 *   `nextAction`, a person decides, and `manifest.verification` records who decided. Guessing the
 *   command would reintroduce the original defect in a subtler form: a Gate that looks configured
 *   and verifies the wrong thing.
 *
 * Adding a language here is therefore a convenience, never a correctness fix.
 */

export interface ToolchainMarker {
  /** Stable id, used in messages only. */
  id: string;
  /** File name that identifies the toolchain, matched exactly in a scanned directory. */
  file: string;
  /** What a project of this shape usually runs. Advisory text, not a default. */
  suggests: Partial<Record<'unit-tests' | 'security-scan', string[]>>;
}

export const TOOLCHAIN_MARKERS: readonly ToolchainMarker[] = [
  { id: 'node', file: 'package.json', suggests: { 'unit-tests': ['npm', 'test'], 'security-scan': ['npm', 'audit', '--audit-level=high'] } },
  { id: 'rust', file: 'Cargo.toml', suggests: { 'unit-tests': ['cargo', 'test'], 'security-scan': ['cargo', 'audit'] } },
  { id: 'go', file: 'go.mod', suggests: { 'unit-tests': ['go', 'test', './...'], 'security-scan': ['govulncheck', './...'] } },
  { id: 'python-pyproject', file: 'pyproject.toml', suggests: { 'unit-tests': ['pytest'], 'security-scan': ['pip-audit'] } },
  { id: 'python-setup', file: 'setup.py', suggests: { 'unit-tests': ['pytest'] } },
  { id: 'maven', file: 'pom.xml', suggests: { 'unit-tests': ['mvn', '-q', 'verify'] } },
  { id: 'gradle', file: 'build.gradle', suggests: { 'unit-tests': ['gradle', 'test'] } },
  { id: 'gradle-kts', file: 'build.gradle.kts', suggests: { 'unit-tests': ['gradle', 'test'] } },
  { id: 'ruby', file: 'Gemfile', suggests: { 'unit-tests': ['bundle', 'exec', 'rspec'], 'security-scan': ['bundle', 'audit'] } },
  { id: 'php', file: 'composer.json', suggests: { 'unit-tests': ['composer', 'test'] } },
  { id: 'elixir', file: 'mix.exs', suggests: { 'unit-tests': ['mix', 'test'] } },
  { id: 'swift', file: 'Package.swift', suggests: { 'unit-tests': ['swift', 'test'] } },
  { id: 'dotnet', file: 'global.json', suggests: { 'unit-tests': ['dotnet', 'test'] } },
  { id: 'cmake', file: 'CMakeLists.txt', suggests: { 'unit-tests': ['ctest'] } },
  { id: 'zig', file: 'build.zig', suggests: { 'unit-tests': ['zig', 'build', 'test'] } },
  { id: 'deno', file: 'deno.json', suggests: { 'unit-tests': ['deno', 'test'] } },
  { id: 'bazel', file: 'MODULE.bazel', suggests: { 'unit-tests': ['bazel', 'test', '//...'] } },
];

export interface DetectedToolchain {
  id: string;
  /** Project-relative path of the marker file, and the key a dismissal must name. */
  marker: string;
  /** The module this marker sits in, when it is a declared module root. */
  module?: string;
  suggests: ToolchainMarker['suggests'];
}

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

/**
 * Markers directly inside the project root and inside each declared module root.
 *
 * Scoped rather than recursive on purpose. A recursive walk finds `package.json` inside
 * `node_modules`, `vendor`, and test fixtures, and every one of those would become a question
 * somebody has to dismiss — which is how a well-meant prompt turns into noise people learn to
 * ignore. The directories a project has declared as its own are exactly the ones it answers for.
 */
export async function detectToolchains(project: ProjectContext): Promise<DetectedToolchain[]> {
  const roots: Array<{ relative: string; module?: string }> = [{ relative: '.' }];
  for (const module of project.manifest.project.modules) {
    const normalized = module.path.replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!normalized || normalized === '.') continue;
    roots.push({ relative: normalized, module: module.id });
  }

  const found: DetectedToolchain[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const marker of TOOLCHAIN_MARKERS) {
      const relative = root.relative === '.' ? marker.file : `${root.relative}/${marker.file}`;
      if (seen.has(relative)) continue;
      let absolute: string;
      try { absolute = await safeResolve(project.root, relative); }
      catch { continue; }
      if (!await exists(absolute)) continue;
      seen.add(relative);
      found.push({ id: marker.id, marker: relative, ...(root.module ? { module: root.module } : {}), suggests: marker.suggests });
    }
  }
  return found.sort((left, right) => left.marker.localeCompare(right.marker));
}

/** Human-readable suggestion for a Gate, or null when this CLI has none for that toolchain. */
export function suggestionFor(detected: DetectedToolchain, gate: string): string[] | null {
  return detected.suggests[gate as 'unit-tests' | 'security-scan'] ?? null;
}

/** Where a suggestion would run from, so a monorepo module's command is not run at the root. */
export function suggestedWorkingDirectory(detected: DetectedToolchain): string {
  const directory = path.posix.dirname(detected.marker);
  return directory === '.' ? '.' : directory;
}
