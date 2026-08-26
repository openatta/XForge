import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectContext } from '../types.js';
import { PROTOCOL_VERSION } from '../constants.js';
import { sha256 } from './hash.js';
import { dumpYaml } from './yaml.js';
import type { SelectedResources } from './resource-loader.js';
import { XForgeError, diagnostic } from './errors.js';
import { runtimeCliIntegrity } from './identity.js';

/**
 * Every file under a locked resource, with its bytes, refusing symlinks outright.
 *
 * `core/identity.ts` has a function of the same name that returns paths and *skips* symlinks. The
 * difference is deliberate and load-bearing: an integrity digest that silently skipped a symlink
 * would let one be added without moving the digest, so this one throws where the other continues.
 */
async function filesUnder(directory: string, prefix = ''): Promise<Array<{ relative: string; content: Buffer }>> {
  const result: Array<{ relative: string; content: Buffer }> = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new XForgeError(diagnostic('XFORGE_RESOURCE_SYMLINK_FORBIDDEN', 'Symlinks are forbidden inside locked resources.', relative));
    if (stat.isDirectory()) result.push(...await filesUnder(absolute, relative));
    else if (stat.isFile()) result.push({ relative, content: await readFile(absolute) });
  }
  return result;
}

function contentDigest(files: Array<{ relative: string; content: Buffer }>): string {
  if (files.length === 1) return sha256(files[0]!.content);
  return sha256(files
    .sort((left, right) => left.relative.localeCompare(right.relative))
    .map((file) => `${file.relative}\0${sha256(file.content)}\n`)
    .join(''));
}

interface LockedResourceEntry {
  id: string;
  kind: string;
  version: string | number;
  digest: string;
  license: string;
}

export async function resolvedResourceEntries(project: ProjectContext, resources: SelectedResources): Promise<LockedResourceEntry[]> {
  const entries: Array<{ id: string; kind: string; version: string | number; digest: string; license: string }> = [];
  for (const [id, directory] of resources.skills) {
    const content = await readFile(path.join(directory, 'SKILL.md'));
    const text = content.toString('utf8');
    const version = text.match(/\n\s*version:\s*["']?([^\n"']+)/)?.[1]?.trim() ?? '1';
    const license = text.match(/\nlicense:\s*([^\n]+)/)?.[1]?.trim() ?? 'project';
    entries.push({ id, kind: 'skill', version, digest: contentDigest(await filesUnder(directory)), license });
  }
  for (const [kind, values] of [
    ['agent', resources.agents], ['rule', resources.rules], ['permission-policy', resources.policies], ['hook', resources.hooks], ['gate', resources.gates], ['script', resources.scripts],
  ] as const) {
    for (const [id, item] of values as Map<string, { value: { metadata: { version?: string | number } }; yamlPath: string }>) {
      let resourceFiles: Array<{ relative: string; content: Buffer }>;
      if (kind === 'agent') {
        const agent = item as unknown as { yamlPath: string; instructionsPath: string; instructionPaths: string[] };
        resourceFiles = [
          { relative: path.posix.basename(agent.yamlPath), content: await readFile(path.join(project.root, ...agent.yamlPath.split('/'))) },
        ];
        for (const instructionsPath of agent.instructionPaths) resourceFiles.push({
          relative: path.posix.basename(instructionsPath),
          content: await readFile(path.join(project.root, ...instructionsPath.split('/'))),
        });
      } else if (kind === 'script') {
        resourceFiles = await filesUnder(path.join(project.root, 'xforge', 'scripts', id));
      } else {
        resourceFiles = [{ relative: path.posix.basename(item.yamlPath), content: await readFile(path.join(project.root, ...item.yamlPath.split('/'))) }];
      }
      entries.push({ id, kind, version: item.value.metadata.version ?? 1, digest: contentDigest(resourceFiles), license: 'project' });
    }
  }
  entries.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  return entries;
}

export async function resolvedLock(project: ProjectContext, resources: SelectedResources): Promise<string> {
  const entries = await resolvedResourceEntries(project, resources);
  return dumpYaml({
    apiVersion: 'xforge.dev/v1alpha2',
    kind: 'Lock',
    protocol: PROTOCOL_VERSION,
    scaffold: { version: project.manifest.scaffold.version, source: project.manifest.scaffold.source, language: project.manifest.scaffold.language },
    xforge: { ...project.manifest.xforge, integrity: runtimeCliIntegrity() },
    paths: { specs: project.specsPath, changes: project.changesPath },
    resources: entries,
    targets: project.manifest.targets,
    generatedProtocol: PROTOCOL_VERSION,
  });
}
