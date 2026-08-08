import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { FileChange, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from './errors.js';
import { sha256 } from './hash.js';
import { safeResolve } from './path-safety.js';

interface RequirementBlock {
  name: string;
  content: string;
}

export interface SpecMutation {
  path: string;
  content: string | null;
  change: FileChange;
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

function section(source: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^## ${escaped}\\s*$`, 'm').exec(source);
  if (!header || header.index === undefined) return null;
  const bodyStart = source.indexOf('\n', header.index + header[0].length);
  if (bodyStart < 0) return '';
  const remainder = source.slice(bodyStart + 1);
  const next = /^## /m.exec(remainder);
  return next?.index === undefined ? remainder : remainder.slice(0, next.index);
}

function requirements(source: string): RequirementBlock[] {
  const headers = [...source.matchAll(/^### Requirement:\s*(.+?)\s*$/gm)];
  return headers.map((match, index) => {
    const start = match.index!;
    const end = headers[index + 1]?.index ?? source.length;
    return { name: match[1]!.trim(), content: source.slice(start, end).trimEnd() };
  });
}

function uniqueRequirements(blocks: RequirementBlock[], label: string, filePath: string): Map<string, RequirementBlock> {
  const result = new Map<string, RequirementBlock>();
  for (const block of blocks) {
    if (result.has(block.name)) throw new XForgeError(diagnostic('XFORGE_SPEC_REQUIREMENT_DUPLICATE', `Duplicate ${label} requirement: ${block.name}`, filePath));
    result.set(block.name, block);
  }
  return result;
}

function renamePairs(source: string): Array<{ from: string; to: string }> {
  const result: Array<{ from: string; to: string }> = [];
  const lines = source.split(/\r?\n/);
  let from: string | null = null;
  for (const line of lines) {
    const fromMatch = line.match(/FROM:\s*(?:`?### Requirement:\s*)?(.+?)`?\s*$/i);
    if (fromMatch) { from = fromMatch[1]!.trim(); continue; }
    const toMatch = line.match(/TO:\s*(?:`?### Requirement:\s*)?(.+?)`?\s*$/i);
    if (toMatch && from) { result.push({ from, to: toMatch[1]!.trim() }); from = null; }
  }
  return result;
}

function hasDeltaSections(source: string): boolean {
  return /^## (?:ADDED|MODIFIED|REMOVED|RENAMED) Requirements\s*$/m.test(source);
}

function mainParts(source: string): { before: string; after: string; blocks: RequirementBlock[] } {
  const match = /^## Requirements\s*$/m.exec(source);
  if (!match || match.index === undefined) throw new XForgeError(diagnostic('XFORGE_SPEC_MAIN_INVALID', 'Existing main Spec requires a ## Requirements section.'));
  const start = match.index;
  const bodyStart = source.indexOf('\n', start + match[0].length);
  const remainderStart = bodyStart < 0 ? source.length : bodyStart + 1;
  const remainder = source.slice(remainderStart);
  const next = /^## /m.exec(remainder);
  const body = next?.index === undefined ? remainder : remainder.slice(0, next.index);
  const after = next?.index === undefined ? '' : remainder.slice(next.index).trim();
  return { before: source.slice(0, start).trimEnd(), after, blocks: requirements(body) };
}

function convertNewDelta(delta: string, relative: string): string {
  const added = section(delta, 'ADDED Requirements');
  const modified = section(delta, 'MODIFIED Requirements');
  const removed = section(delta, 'REMOVED Requirements');
  const renamed = section(delta, 'RENAMED Requirements');
  if ((modified && requirements(modified).length > 0) || (removed && requirements(removed).length > 0) || (renamed && renamePairs(renamed).length > 0)) {
    throw new XForgeError(diagnostic('XFORGE_SPEC_MERGE_CONFLICT', 'A new capability cannot modify, remove, or rename requirements that do not exist.', relative));
  }
  const blocks = requirements(added ?? '');
  if (blocks.length === 0) throw new XForgeError(diagnostic('XFORGE_SPEC_DELTA_EMPTY', 'A new delta Spec must add at least one requirement.', relative));
  const title = path.posix.basename(path.posix.dirname(relative)).replace(/-/g, ' ');
  return `# ${title}\n\n## Purpose\n\nEstablished by archived XForge Changes.\n\n## Requirements\n\n${blocks.map((block) => block.content).join('\n\n')}\n`;
}

function mergeExisting(main: string, delta: string, relative: string): string | null {
  const parts = mainParts(main);
  const active = uniqueRequirements(parts.blocks, 'main', relative);
  const additions = uniqueRequirements(requirements(section(delta, 'ADDED Requirements') ?? ''), 'added', relative);
  const modifications = uniqueRequirements(requirements(section(delta, 'MODIFIED Requirements') ?? ''), 'modified', relative);
  const removals = requirements(section(delta, 'REMOVED Requirements') ?? '');
  const renames = renamePairs(section(delta, 'RENAMED Requirements') ?? '');

  for (const [name, block] of additions) {
    if (active.has(name)) throw new XForgeError(diagnostic('XFORGE_SPEC_MERGE_CONFLICT', `Cannot add existing requirement: ${name}`, relative));
    active.set(name, block);
  }
  for (const [name, block] of modifications) {
    if (!active.has(name)) throw new XForgeError(diagnostic('XFORGE_SPEC_MERGE_CONFLICT', `Cannot modify missing requirement: ${name}`, relative));
    active.set(name, block);
  }
  for (const block of removals) {
    if (!active.delete(block.name)) throw new XForgeError(diagnostic('XFORGE_SPEC_MERGE_CONFLICT', `Cannot remove missing requirement: ${block.name}`, relative));
  }
  for (const rename of renames) {
    const block = active.get(rename.from);
    if (!block || active.has(rename.to)) throw new XForgeError(diagnostic('XFORGE_SPEC_MERGE_CONFLICT', `Cannot rename ${rename.from} to ${rename.to}.`, relative));
    const replaced = block.content.replace(/^### Requirement:\s*.+$/m, `### Requirement: ${rename.to}`);
    active.delete(rename.from);
    active.set(rename.to, { name: rename.to, content: replaced });
  }
  if (active.size === 0) return null;
  const rendered = `${parts.before}\n\n## Requirements\n\n${[...active.values()].map((block) => block.content).join('\n\n')}`;
  return `${rendered}${parts.after ? `\n\n${parts.after}` : ''}\n`;
}

export async function planSpecMutations(project: ProjectContext, changeId: string): Promise<SpecMutation[]> {
  const changeDirectory = await safeResolve(project.root, `${project.changesPath}/${changeId}`);
  const deltaPaths = (await fg('specs/**/*.md', {
    cwd: changeDirectory, onlyFiles: true, followSymbolicLinks: false, dot: false, unique: true,
  })).sort();
  const mutations: SpecMutation[] = [];
  for (const deltaPath of deltaPaths) {
    const capabilityRelative = deltaPath.slice('specs/'.length);
    const destinationRelative = `${project.specsPath}/${capabilityRelative}`;
    const delta = await readFile(await safeResolve(changeDirectory, deltaPath), 'utf8');
    const destination = await safeResolve(project.root, destinationRelative);
    const destinationExists = await exists(destination);
    let content: string | null;
    if (!destinationExists) {
      content = hasDeltaSections(delta) ? convertNewDelta(delta, deltaPath) : delta.endsWith('\n') ? delta : `${delta}\n`;
    } else {
      const main = await readFile(destination, 'utf8');
      if (!hasDeltaSections(delta)) {
        if (main === delta || `${main.trimEnd()}\n` === `${delta.trimEnd()}\n`) continue;
        throw new XForgeError(diagnostic('XFORGE_SPEC_MERGE_CONFLICT', 'A full Change Spec cannot silently replace an existing main Spec; use requirement delta sections.', deltaPath));
      }
      content = mergeExisting(main, delta, deltaPath);
      if (content === main) continue;
    }
    mutations.push({
      path: destinationRelative,
      content,
      change: content === null
        ? { action: 'delete', path: destinationRelative, source: `change:${changeId}:${deltaPath}` }
        : { action: destinationExists ? 'modify' : 'create', path: destinationRelative, digest: sha256(content), source: `change:${changeId}:${deltaPath}` },
    });
  }
  return mutations;
}
