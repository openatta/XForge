import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from './errors.js';
import { sha256 } from './hash.js';
import { safeResolve } from './path-safety.js';
import { hasContractDeltaSections, parseContractDelta } from './contract-delta.js';
import { exists } from './files.js';
import { maskFencedCode } from './markdown-fences.js';

/**
 * The contract baseline is a record, not a dialect document.
 *
 * `xforge/contracts/` holds one markdown file per contract domain, listing the elements that domain
 * exposes as of the last archive. It is not an OpenAPI document, a `.proto` or a schema dump, and
 * that is the point: XForge understands no dialect and will not learn one, so a baseline it can
 * merge has to be addressed in the only vocabulary both sides share -- the `<kind>:<selector>` id an
 * adapter prints. The dialect document stays where it belongs, in the implementation, and a project
 * compares the two with its own `contract-compat` command.
 *
 * This is the baseline-snapshot method api-extractor and cargo-public-api use, with the merge moved
 * into the governance layer: the recorded surface advances only through a reviewed delta, so
 * "somebody changed an interface" and "somebody agreed to change an interface" stop being the same
 * event.
 *
 * The shape mirrors core/spec-merger.ts closely enough to be read beside it, because the risk is the
 * same and so is the fix. What differs is the key: a Requirement is keyed by a title a person wrote,
 * so that merger has to suggest near misses when a heading was reworded; an element is keyed by an
 * id a machine printed, so a key that does not match is a different element and there is nothing to
 * suggest.
 */

interface ElementBlock {
  id: string;
  content: string;
}

interface ContractMutation {
  path: string;
  content: string | null;
  change: FileChange;
}

/** See core/spec-merger.ts's ConflictSink: archive stops on the first conflict, check collects all. */
type ConflictSink = (item: Diagnostic) => void;

const THROW_ON_CONFLICT: ConflictSink = (item) => { throw new XForgeError(item); };

function elementBlocks(source: string, masked = maskFencedCode(source)): ElementBlock[] {
  /* Scanned on the mask, sliced from the source: an element that documents a payload by showing it
     has `### ` lines of its own inside the fence, and each one used to start a new element. */
  const headers = [...masked.matchAll(/^### Element:\s*(.+?)\s*$/gm)];
  return headers.map((match, index) => {
    const start = match.index!;
    const end = headers[index + 1]?.index ?? source.length;
    return { id: match[1]!.trim(), content: source.slice(start, end).trimEnd() };
  });
}

/** The `## Elements` body of a baseline record, plus whatever surrounds it. */
function recordParts(source: string): { before: string; after: string; blocks: ElementBlock[] } {
  /* The mask indexes identically to the source, so every boundary found in one slices the other. */
  const masked = maskFencedCode(source);
  const match = /^## Elements\s*$/m.exec(masked);
  if (!match || match.index === undefined) return { before: source.trimEnd(), after: '', blocks: [] };
  const bodyStart = source.indexOf('\n', match.index + match[0].length);
  const remainderStart = bodyStart < 0 ? source.length : bodyStart + 1;
  const remainder = source.slice(remainderStart);
  const maskedRemainder = masked.slice(remainderStart);
  const next = /^## /m.exec(maskedRemainder);
  const body = next?.index === undefined ? remainder : remainder.slice(0, next.index);
  const maskedBody = next?.index === undefined ? maskedRemainder : maskedRemainder.slice(0, next.index);
  const after = next?.index === undefined ? '' : remainder.slice(next.index).trim();
  return { before: source.slice(0, match.index).trimEnd(), after, blocks: elementBlocks(body, maskedBody) };
}

/** The elements one operation section of a delta names. */
function deltaSection(delta: string, operation: 'ADDED' | 'MODIFIED' | 'REMOVED'): ElementBlock[] {
  const section = parseContractDelta(delta).sections.find((item) => item.operation === operation);
  return (section?.elements ?? []).map((element) => ({ id: element.id, content: element.content }));
}

function conflict(message: string, relative: string): Diagnostic {
  return diagnostic('XFORGE_CONTRACT_MERGE_CONFLICT', message, relative);
}

function render(before: string, after: string, blocks: ElementBlock[]): string {
  const rendered = `${before}\n\n## Elements\n\n${blocks.map((block) => block.content).join('\n\n')}`;
  return `${rendered}${after ? `\n\n${after}` : ''}\n`;
}

function convertNewDelta(delta: string, relative: string, raise: ConflictSink): string | null {
  if (deltaSection(delta, 'MODIFIED').length > 0 || deltaSection(delta, 'REMOVED').length > 0) {
    raise(conflict(
      `No contract baseline exists at ${relative} yet, so this delta may only ADD. Modifying or removing an element that was never recorded is a claim about a record that does not exist.`,
      relative,
    ));
    return null;
  }
  const added = deltaSection(delta, 'ADDED');
  /* Not a conflict. An all-"(none)" delta on a domain with no baseline is the ordinary state of a
     Change that touched no interface, and it plans nothing rather than creating an empty record. */
  if (added.length === 0) return null;
  const domain = path.posix.basename(relative, '.md');
  return render(`# ${domain.replace(/-/g, ' ')}\n\n## Purpose\n\nEstablished by archived XForge Changes.`, '', added);
}

function mergeExisting(record: string, delta: string, relative: string, raise: ConflictSink): string | null {
  const operations = [...deltaSection(delta, 'ADDED'), ...deltaSection(delta, 'MODIFIED'), ...deltaSection(delta, 'REMOVED')];
  /*
   * A delta that declares nothing plans nothing, decided before the merge rather than after it.
   *
   * Two things went wrong when this was left to the comparison at the end. `null` means "this delta
   * removed the last element, delete the record", and a record that was already empty reaches the
   * same zero by a different route -- so the ordinary Change, the one whose delta says "(none)" in
   * every section, deleted a governed file it had just declared it was not touching. And re-rendering
   * normalises whitespace, so a baseline a person wrote came back as a `modify` from a Change that
   * changed nothing, which reaches the archive's change list, `data.contracts`, and every other
   * in-flight Change as "code moved since".
   *
   * Returning the record verbatim is what the caller already reads as "nothing to do".
   *
   * It also returns before the duplicate-id check below, so a baseline that records one id twice is
   * not reported to a Change that merges nothing into it. That is the intended reading: a Change
   * declaring no interface change should not be blocked by a defect in a file it is not touching,
   * and the next Change that does merge into that domain still meets it.
   */
  if (operations.length === 0) return record;
  const parts = recordParts(record);
  const active = new Map<string, ElementBlock>();
  for (const block of parts.blocks) {
    if (active.has(block.id)) {
      raise(conflict(`The baseline records "${block.id}" more than once, so a merge cannot say which block it means.`, relative));
      continue;
    }
    active.set(block.id, block);
  }

  for (const block of deltaSection(delta, 'ADDED')) {
    if (active.has(block.id)) {
      raise(conflict(`Cannot add "${block.id}": the baseline already records it. Declare it under MODIFIED Contract Elements if this Change changes it.`, relative));
      continue;
    }
    active.set(block.id, block);
  }
  for (const block of deltaSection(delta, 'MODIFIED')) {
    if (!active.has(block.id)) {
      raise(conflict(`Cannot modify "${block.id}": the baseline does not record it. Declare it under ADDED Contract Elements if this Change introduces it.`, relative));
      continue;
    }
    active.set(block.id, block);
  }
  for (const block of deltaSection(delta, 'REMOVED')) {
    if (!active.delete(block.id)) {
      raise(conflict(`Cannot remove "${block.id}": the baseline does not record it.`, relative));
    }
  }

  if (active.size === 0) return null;
  return render(parts.before, parts.after, [...active.values()]);
}

async function planContractMutationsWith(project: ProjectContext, changeId: string, raise: ConflictSink): Promise<ContractMutation[]> {
  const changeDirectory = await safeResolve(project.root, `${project.changesPath}/${changeId}`);
  const deltaPaths = (await fg('contracts/**/*.md', {
    cwd: changeDirectory, onlyFiles: true, followSymbolicLinks: false, dot: false, unique: true,
  })).sort();
  const mutations: ContractMutation[] = [];
  for (const deltaPath of deltaPaths) {
    const domainRelative = deltaPath.slice('contracts/'.length);
    const destinationRelative = `${project.contractsPath}/${domainRelative}`;
    /* Project-relative: these diagnostics are read at `check`, which groups a Change's findings by
       whether their path is inside the Change directory. */
    const reported = `${project.changesPath}/${changeId}/${deltaPath}`;
    const delta = await readFile(await safeResolve(changeDirectory, deltaPath), 'utf8');
    if (!hasContractDeltaSections(delta)) {
      raise(conflict('A contract delta must use element delta sections (## ADDED Contract Elements), not a baseline record.', reported));
      continue;
    }
    const destination = await safeResolve(project.root, destinationRelative);
    const destinationExists = await exists(destination);

    /* Per file, for the reason core/spec-merger.ts gives: `content: null` already means "every
       element was removed, delete the record", and a refused merge must not arrive at that value. */
    let conflicted = false;
    const raiseHere: ConflictSink = (item) => { conflicted = true; raise(item); };
    let content: string | null;
    if (!destinationExists) {
      content = convertNewDelta(delta, reported, raiseHere);
      if (content === null) continue;
    } else {
      const record = await readFile(destination, 'utf8');
      content = mergeExisting(record, delta, reported, raiseHere);
      if (content === record) continue;
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
export async function planContractMutations(project: ProjectContext, changeId: string): Promise<ContractMutation[]> {
  return planContractMutationsWith(project, changeId, THROW_ON_CONFLICT);
}

/**
 * Whether this Change's contract deltas can be merged into the baseline, answered without archiving.
 *
 * Same merge, run for its refusals, for the reason core/spec-merger.ts's equivalent spells out: the
 * archive path plans no mutation until every governance block is clear, so the question could not be
 * asked before a human had already signed, and the only route back from the answer voids that
 * signature. Necessary but not sufficient — another Change can archive first and move the very
 * baseline this compared against, so archive still re-decides it.
 */
export async function validateContractMergeFeasibility(project: ProjectContext, changeId: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  try {
    await planContractMutationsWith(project, changeId, (item) => { diagnostics.push(item); });
  } catch (error) {
    /* Anything still thrown is a failure of the read itself, not a merge conflict. Reported rather
       than swallowed: a validation that returns "no conflicts" because it could not run is the worst
       of both answers. */
    if (error instanceof XForgeError) return [...diagnostics, ...error.diagnostics];
    throw error;
  }
  return diagnostics;
}
