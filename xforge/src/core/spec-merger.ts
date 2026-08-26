import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from './errors.js';
import { sha256 } from './hash.js';
import { safeResolve } from './path-safety.js';
import { hasDeltaSections, renamePairs } from './spec-delta.js';
import { exists } from './files.js';

interface RequirementBlock {
  name: string;
  content: string;
}

export interface SpecMutation {
  path: string;
  content: string | null;
  change: FileChange;
}

/**
 * What a merge conflict does, decided by the caller rather than by the merger.
 *
 * `archive` must stop dead on the first one: it is performing a transaction, and a partially applied
 * Spec merge is worse than none. `check` must do the opposite — report every conflict it can see,
 * because the whole point of moving this check earlier is to spare the operator a round trip per
 * conflict. Both readings run the *same* merge, which is the property that matters: a second
 * implementation of "can this delta be merged" would be free to disagree with the one that governs
 * archive, and would then be worse than no check at all.
 */
type ConflictSink = (item: Diagnostic) => void;

/** The archive reading: the first conflict ends the plan. */
const THROW_ON_CONFLICT: ConflictSink = (item) => { throw new XForgeError(item); };

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

function uniqueRequirements(blocks: RequirementBlock[], label: string, filePath: string, raise: ConflictSink): Map<string, RequirementBlock> {
  const result = new Map<string, RequirementBlock>();
  for (const block of blocks) {
    if (result.has(block.name)) {
      raise(diagnostic('XFORGE_SPEC_REQUIREMENT_DUPLICATE', `Duplicate ${label} requirement: ${block.name}`, filePath));
      continue;
    }
    result.set(block.name, block);
  }
  return result;
}

/**
 * A merge conflict, with the near miss named when there is one.
 *
 * The heading is the merge key, so a MODIFIED block whose title was reworded no longer locates the
 * requirement it means to change — and the bare message ("Cannot modify missing requirement: X")
 * describes the symptom rather than the cause, which is that X and the main Spec's own heading are
 * the same requirement under two titles. A live Major run met exactly this: `MCP-009` had been
 * retitled in the delta to reflect the revision, its sibling `MCP-005` had not, and the two
 * behaving differently was the only clue available.
 *
 * The candidate is found by the citable id a heading starts with (`MCP-009 ...` cites as `MCP-009`,
 * the same reading `core/brief.ts` and `core/constitution-check.ts` use), so this suggests only
 * where the project actually numbers its requirements. It stays a suggestion: renaming through
 * `## RENAMED Requirements` and correcting a typo are different intentions, and nothing here can
 * tell which one was meant.
 */
function mergeConflict(message: string, relative: string, active: Map<string, RequirementBlock>, name: string): Diagnostic {
  const id = /^([A-Za-z][A-Za-z0-9]*-\d+)\b/.exec(name)?.[1];
  const candidate = id ? [...active.keys()].find((existing) => existing.startsWith(`${id} `) || existing === id) : undefined;
  const hint = candidate
    ? ` The main Spec has "${candidate}", which cites the same id. A heading is the merge key, so a retitled MODIFIED block no longer finds it: either restore the heading and put the new wording in the body, or use "## RENAMED Requirements" to change the title deliberately.`
    : '';
  return diagnostic('XFORGE_SPEC_MERGE_CONFLICT', `${message}${hint}`, relative);
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

function convertNewDelta(delta: string, relative: string, raise: ConflictSink): string | null {
  const added = section(delta, 'ADDED Requirements');
  const modified = section(delta, 'MODIFIED Requirements');
  const removed = section(delta, 'REMOVED Requirements');
  const renamed = section(delta, 'RENAMED Requirements');
  if ((modified && requirements(modified).length > 0) || (removed && requirements(removed).length > 0) || (renamed && renamePairs(renamed).length > 0)) {
    raise(diagnostic('XFORGE_SPEC_MERGE_CONFLICT', `A new capability cannot modify, remove, or rename requirements that do not exist. No main Spec exists at ${relative.replace(/^specs\//, '')} yet, so this delta may only ADD.`, relative));
    return null;
  }
  const blocks = requirements(added ?? '');
  if (blocks.length === 0) {
    raise(diagnostic('XFORGE_SPEC_DELTA_EMPTY', 'A new delta Spec must add at least one requirement.', relative));
    return null;
  }
  // The delta glob matches nested and flat shapes alike: a capability may be a directory
  // (`specs/x/spec.md`) or a flat file (`specs/x.md`). Taking the parent directory
  // unconditionally titled every flat capability "specs".

  const base = path.posix.basename(relative, '.md');
  const capability = base === 'spec' ? path.posix.basename(path.posix.dirname(relative)) : base;
  const title = capability.replace(/-/g, ' ');
  return `# ${title}\n\n## Purpose\n\nEstablished by archived XForge Changes.\n\n## Requirements\n\n${blocks.map((block) => block.content).join('\n\n')}\n`;
}

function mergeExisting(main: string, delta: string, relative: string, raise: ConflictSink): string | null {
  const parts = mainParts(main);
  const active = uniqueRequirements(parts.blocks, 'main', relative, raise);
  const additions = uniqueRequirements(requirements(section(delta, 'ADDED Requirements') ?? ''), 'added', relative, raise);
  const modifications = uniqueRequirements(requirements(section(delta, 'MODIFIED Requirements') ?? ''), 'modified', relative, raise);
  const removals = requirements(section(delta, 'REMOVED Requirements') ?? '');
  const renames = renamePairs(section(delta, 'RENAMED Requirements') ?? '');

  for (const [name, block] of additions) {
    if (active.has(name)) {
      raise(mergeConflict(`Cannot add existing requirement: ${name}`, relative, active, name));
      continue;
    }
    active.set(name, block);
  }
  for (const [name, block] of modifications) {
    if (!active.has(name)) {
      raise(mergeConflict(`Cannot modify missing requirement: ${name}`, relative, active, name));
      continue;
    }
    active.set(name, block);
  }
  for (const block of removals) {
    if (!active.delete(block.name)) {
      raise(mergeConflict(`Cannot remove missing requirement: ${block.name}`, relative, active, block.name));
    }
  }
  for (const rename of renames) {
    const block = active.get(rename.from);
    if (!block || active.has(rename.to)) {
      raise(mergeConflict(`Cannot rename ${rename.from} to ${rename.to}.`, relative, active, rename.from));
      continue;
    }
    const replaced = block.content.replace(/^### Requirement:\s*.+$/m, `### Requirement: ${rename.to}`);
    active.delete(rename.from);
    active.set(rename.to, { name: rename.to, content: replaced });
  }
  if (active.size === 0) return null;
  const rendered = `${parts.before}\n\n## Requirements\n\n${[...active.values()].map((block) => block.content).join('\n\n')}`;
  return `${rendered}${parts.after ? `\n\n${parts.after}` : ''}\n`;
}

async function planSpecMutationsWith(project: ProjectContext, changeId: string, raise: ConflictSink): Promise<SpecMutation[]> {
  const changeDirectory = await safeResolve(project.root, `${project.changesPath}/${changeId}`);
  const deltaPaths = (await fg('specs/**/*.md', {
    cwd: changeDirectory, onlyFiles: true, followSymbolicLinks: false, dot: false, unique: true,
  })).sort();
  const mutations: SpecMutation[] = [];
  for (const deltaPath of deltaPaths) {
    const capabilityRelative = deltaPath.slice('specs/'.length);
    const destinationRelative = `${project.specsPath}/${capabilityRelative}`;
    /* Project-relative, because these diagnostics are now read outside archive: `check` groups a
       Change's own findings by whether their path sits inside the Change directory, and a bare
       `specs/widget/spec.md` names a file at the repository root that does not exist. */
    const reported = `${project.changesPath}/${changeId}/${deltaPath}`;
    const delta = await readFile(await safeResolve(changeDirectory, deltaPath), 'utf8');
    const destination = await safeResolve(project.root, destinationRelative);
    const destinationExists = await exists(destination);
    /*
     * Per file, because `content: null` already means "every requirement was removed, delete the
     * main Spec". A collecting run must not let a *refused* merge arrive at that same value and be
     * planned as a deletion; it records the conflict and plans nothing for this file.
     */
    let conflicted = false;
    const raiseHere: ConflictSink = (item) => { conflicted = true; raise(item); };
    let content: string | null;
    if (!destinationExists) {
      /* Delta sections are the only accepted shape, for a brand-new capability too. `check` already
         refuses a full main Spec (XFORGE_SPEC_DELTA_NO_SECTION), and the propose Skill and every
         shipped Flow outline prescribe `## ADDED Requirements`. Accepting the full-Spec form only
         here would mean archive silently admitting a document that never passed Scenario
         validation — the exact gap between check and archive this closes. */
      if (!hasDeltaSections(delta)) {
        raiseHere(diagnostic(
          'XFORGE_SPEC_DELTA_NO_SECTION',
          'A new capability Spec must use requirement delta sections (## ADDED Requirements), not a full main Spec.',
          reported,
        ));
        continue;
      }
      content = convertNewDelta(delta, reported, raiseHere);
    } else {
      const main = await readFile(destination, 'utf8');
      if (!hasDeltaSections(delta)) {
        if (main === delta || `${main.trimEnd()}\n` === `${delta.trimEnd()}\n`) continue;
        raiseHere(diagnostic('XFORGE_SPEC_MERGE_CONFLICT', 'A full Change Spec cannot silently replace an existing main Spec; use requirement delta sections.', reported));
        continue;
      }
      content = mergeExisting(main, delta, reported, raiseHere);
      if (content === main) continue;
    }
    if (conflicted) continue;
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

/** The archive reading: plan the merge, and stop on the first conflict. */
export async function planSpecMutations(project: ProjectContext, changeId: string): Promise<SpecMutation[]> {
  return planSpecMutationsWith(project, changeId, THROW_ON_CONFLICT);
}

/**
 * Whether this Change's delta Specs can be merged into the main Specs, answered without archiving.
 *
 * This is the same merge `archive` performs, run for its refusals and with its output discarded. It
 * exists because the answer was previously unavailable until after a human had approved the Change,
 * and not by accident: `core/archiver.ts` returns before it plans any Spec mutation whenever a
 * governance block is present, and "the closing transition has not happened" and "the closing
 * approval is missing" are both governance blocks. So `archive --dry-run` could not be used to ask
 * this question early — the merge plan is computed only once everything else already passes.
 *
 * A live Major run therefore reached `XFORGE_SPEC_MERGE_CONFLICT` with `closing-major` already
 * signed, and the only route back — `transition repair` — voids that approval, because an approval
 * is bound to what it was given for. The check that would have caught it is pure text: two files,
 * no Gate Evidence, no approval, no working tree.
 *
 * Reported at `check`, it is necessary but not sufficient, and deliberately so. Another Change can
 * archive first and move the very main Spec this compared against, so `archive` still re-decides
 * it. That is the same posture every Gate takes toward the revision it ran at.
 */
export async function validateSpecMergeFeasibility(project: ProjectContext, changeId: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  try {
    await planSpecMutationsWith(project, changeId, (item) => { diagnostics.push(item); });
  } catch (error) {
    /* Anything that still throws is a failure of the read itself — an unreadable main Spec, a path
       outside the project — not a merge conflict. Reported rather than swallowed: a validation that
       returns "no conflicts" because it could not run is the worst of both answers. */
    if (error instanceof XForgeError) return [...diagnostics, ...error.diagnostics];
    throw error;
  }
  return diagnostics;
}
