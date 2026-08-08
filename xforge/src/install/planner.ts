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
  ProjectContext,
} from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { safeResolve } from '../core/path-safety.js';
import { loadSelectedResources, type SelectedResources } from '../core/resource-loader.js';
import { readOwnership } from './ownership.js';

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

async function buildDesired(resources: SelectedResources, targets: TargetId[]): Promise<Map<string, DesiredFile>> {
  const desired = new Map<string, DesiredFile>();
  for (const target of targets) {
    const adapter = getAdapter(target);
    for (const bootstrap of adapter.bootstrap()) addDesired(desired, bootstrap);

    for (const [id, directory] of resources.skills) {
      for (const file of await sourceFiles(directory)) {
        addDesired(desired, {
          path: `${adapter.skillDirectory(id)}/${file.relative}`,
          content: file.content,
          source: `skill:${id}:${file.relative}`,
          target,
        });
      }
      const commandPath = adapter.commandPath(id);
      const commandContent = adapter.renderCommand(id);
      if (commandPath && commandContent != null) addDesired(desired, {
        path: commandPath, content: Buffer.from(commandContent), source: `skill-command:${id}`, target,
      });
    }

    for (const [id, agent] of resources.agents) {
      const outputPath = adapter.agentPath(id);
      const output = adapter.renderAgent(agent.value, agent.instructions);
      if (outputPath && output != null) addDesired(desired, {
        path: outputPath, content: Buffer.from(output), source: `agent:${id}`, target,
      });
    }

    for (const [id, rule] of resources.rules) {
      const outputPath = adapter.rulePath(id);
      const output = adapter.renderRule(rule.value);
      if (outputPath && output != null) addDesired(desired, {
        path: outputPath, content: Buffer.from(output), source: `rule:${id}`, target,
      });
    }
  }
  return desired;
}

async function currentFile(project: ProjectContext, relative: string): Promise<{ content: Buffer; digest: string; symlink: boolean } | null> {
  const absolute = await safeResolve(project.root, relative);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return { content: Buffer.alloc(0), digest: '', symlink: true };
    if (!stat.isFile()) return { content: Buffer.alloc(0), digest: '', symlink: true };
    const content = await readFile(absolute);
    return { content, digest: sha256(content), symlink: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface InstallPlan {
  resources: SelectedResources;
  targets: TargetId[];
  desired: Map<string, DesiredFile>;
  previous: OwnershipState;
  next: OwnershipState;
  changes: FileChange[];
  diagnostics: Diagnostic[];
}

function recordFor(file: DesiredFile): ManagedFileRecord {
  const digest = sha256(file.content);
  return {
    source: file.source,
    target: file.target,
    cliVersion: CLI_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    digest,
    lastInstalledDigest: digest,
  };
}

function hasSecretLikeContent(content: Buffer): boolean {
  const text = content.toString('utf8');
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /\bAKIA[0-9A-Z]{16}\b/.test(text)
    || /\b(?:password|passwd|secret|api[_-]?key|(?:access[_-]?)?token)\s*[:=]\s*(?!\[REDACTED\]|<[^>]+>|\$\{)["']?[A-Za-z0-9_+\-/=.]{8,}/i.test(text);
}

export async function planInstall(project: ProjectContext, target?: TargetId): Promise<InstallPlan> {
  const targets = target ? [target] : project.manifest.targets;
  if (target && !project.manifest.targets.includes(target)) {
    throw new XForgeError(diagnostic('XFORGE_TARGET_NOT_ENABLED', `Target is not enabled by the Manifest: ${target}`, 'xforge/manifest.yaml'), { root: project.root });
  }
  const resources = await loadSelectedResources(project);
  const desired = await buildDesired(resources, targets);
  const previous = await readOwnership(project);
  const nextFiles = { ...previous.files };
  const changes: FileChange[] = [];
  const diagnostics = [...resources.diagnostics];
  for (const [relative, file] of desired) {
    if (hasSecretLikeContent(file.content)) diagnostics.push(diagnostic(
      'XFORGE_SECRET_IN_GENERATED_CONTENT',
      'Secret-like material is forbidden in generated Adapter files.',
      relative,
    ));
  }

  for (const [relative, file] of [...desired].sort(([left], [right]) => left.localeCompare(right))) {
    const current = await currentFile(project, relative);
    const owned = previous.files[relative];
    const desiredDigest = sha256(file.content);
    if (current?.symlink) {
      changes.push({ action: 'conflict', path: relative, source: file.source, target: file.target, reason: 'Destination is a symlink or non-file.' });
      diagnostics.push(diagnostic('XFORGE_INSTALL_CONFLICT', 'Generated destination is a symlink or non-file.', relative));
      continue;
    }
    if (!current) {
      changes.push({ action: 'create', path: relative, digest: desiredDigest, source: file.source, target: file.target });
      nextFiles[relative] = recordFor(file);
      continue;
    }
    if (!owned) {
      changes.push({ action: 'conflict', path: relative, digest: current.digest, source: file.source, target: file.target, reason: 'Existing file is not XForge-managed.' });
      diagnostics.push(diagnostic('XFORGE_INSTALL_CONFLICT', 'Existing destination is not owned by XForge.', relative));
      continue;
    }
    if (current.digest !== owned.lastInstalledDigest || current.digest !== owned.digest) {
      changes.push({ action: 'conflict', path: relative, digest: current.digest, source: file.source, target: file.target, reason: 'Managed file was modified after installation.' });
      diagnostics.push(diagnostic('XFORGE_MANAGED_FILE_MODIFIED', 'Managed destination differs from its last installed digest.', relative));
      continue;
    }
    if (current.digest === desiredDigest) changes.push({ action: 'skip', path: relative, digest: desiredDigest, source: file.source, target: file.target, reason: 'Already current.' });
    else changes.push({ action: 'modify', path: relative, digest: desiredDigest, source: file.source, target: file.target });
    nextFiles[relative] = recordFor(file);
  }

  for (const [relative, owned] of Object.entries(previous.files).sort(([left], [right]) => left.localeCompare(right))) {
    if (!targets.includes(owned.target) || desired.has(relative)) continue;
    const current = await currentFile(project, relative);
    if (!current) {
      delete nextFiles[relative];
      continue;
    }
    if (current.symlink || current.digest !== owned.lastInstalledDigest || current.digest !== owned.digest) {
      changes.push({ action: 'conflict', path: relative, digest: current.digest, source: owned.source, target: owned.target, reason: 'Disabled managed file was modified and cannot be pruned.' });
      diagnostics.push(diagnostic('XFORGE_MANAGED_FILE_MODIFIED', 'Modified managed file cannot be removed by managed-only pruning.', relative));
      continue;
    }
    changes.push({ action: 'delete', path: relative, digest: current.digest, source: owned.source, target: owned.target });
    delete nextFiles[relative];
  }

  return {
    resources,
    targets,
    desired,
    previous,
    next: {
      version: 1,
      generatedAt: changes.some((item) => ['create', 'modify', 'delete'].includes(item.action))
        ? new Date().toISOString()
        : previous.generatedAt,
      files: nextFiles,
    },
    changes,
    diagnostics,
  };
}
