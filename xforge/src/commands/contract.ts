import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { Diagnostic, ProjectContext } from '../types.js';
import { parseContractDelta } from '../core/contract-delta.js';
import { maskFencedCode } from '../core/markdown-fences.js';
import { diagnostic } from '../core/errors.js';
import { moduleOf } from '../core/contract-delta.js';
import { safeResolve } from '../core/path-safety.js';
import { listChangeDirectories } from '../core/change-directories.js';

/**
 * What the contract baseline currently records, read back.
 *
 * A contract delta addresses elements by an id it does not invent: `openapi:paths./orders.post` is
 * only usable if the writer can see that this is how the baseline spells it. Without a way to ask,
 * the ids get retyped from memory, and a retyped id does not fail loudly — it merges as an ADDED
 * element beside the one it was meant to modify, and the baseline grows a near-duplicate that
 * nothing compares.
 *
 * Read-only, and there is deliberately no `contract add` beside it. The baseline advances by a
 * merged delta and by nothing else; a command that wrote an element directly would be a second
 * writer for the record whose whole value is having one.
 */
interface ContractListResult {
  ok: boolean;
  data: {
    contractsPath: string;
    domains: Array<{
      domain: string;
      path: string;
      elements: Array<{ id: string; kind: string; module: string }>;
    }>;
    elementCount: number;
  };
  diagnostics: Diagnostic[];
}

/**
 * The `## Elements` body of a baseline record, or the whole file when it has no such section.
 *
 * Named once and shared, because two readings of the same file is how the list and the merge came to
 * disagree about which ids exist.
 */
/**
 * The `## Elements` body, and a fence-masked copy of it that indexes identically.
 *
 * Both are needed because the caller slices one and scans the other: an element that documents a
 * payload by showing it carries `## ` and `### ` lines inside its fence, and a bare scan read the
 * first of them as the end of the section. A three-element baseline listed one, and the two it
 * dropped were then unmodifiable -- the merger said "the baseline does not record it" about
 * elements plainly in the file, and its own remedy (declare them under ADDED) was accepted, which
 * writes a second block for an id the baseline already held.
 */
function elementsSection(source: string): { text: string; masked: string } {
  const masked = maskFencedCode(source);
  const header = /^## Elements\s*$/m.exec(masked);
  if (!header || header.index === undefined) return { text: source, masked };
  const bodyStart = source.indexOf('\n', header.index + header[0].length);
  if (bodyStart < 0) return { text: '', masked: '' };
  const remainder = source.slice(bodyStart + 1);
  const maskedRemainder = masked.slice(bodyStart + 1);
  const next = /^## /m.exec(maskedRemainder);
  if (next?.index === undefined) return { text: remainder, masked: maskedRemainder };
  return { text: remainder.slice(0, next.index), masked: maskedRemainder.slice(0, next.index) };
}

/**
 * Diagnostics for a read that failed, never an empty list.
 *
 * An `XForgeError` already carries what to say. Anything else is a raw filesystem error, and the
 * caller's envelope derives `ok` from the diagnostics -- so returning none turns a failure into a
 * confident "nothing here".
 */
function unreadable(error: unknown, path: string, summary: string): Diagnostic[] {
  const carried = (error as { diagnostics?: Diagnostic[] }).diagnostics;
  if (carried?.length) return carried;
  const reason = error instanceof Error ? error.message : String(error);
  return [diagnostic('XFORGE_CONTRACT_READ_FAILED', `${summary}: ${reason}`, path)];
}

/** `openapi:paths./orders.post` -> `openapi`. Empty for an id the baseline stored without one. */
function kindOf(id: string): string {
  const index = id.indexOf(':');
  return index > 0 ? id.slice(0, index) : '';
}

export async function executeContractList(
  project: ProjectContext,
  options: { kind?: string },
): Promise<ContractListResult> {
  const diagnostics: Diagnostic[] = [];
  const domains: ContractListResult['data']['domains'] = [];
  let directory: string;
  try {
    directory = await safeResolve(project.root, project.contractsPath);
  } catch (error) {
    /*
     * A read that failed must not answer as a read that found nothing.
     *
     * `safeResolve` rethrows a raw Node error for anything that is not a missing path -- EACCES on
     * the tree or a parent, a broken mount -- and those carry no `diagnostics`. Taking `?? []` there
     * produced an empty diagnostics array, and the envelope derives `ok` from the diagnostics, so an
     * unreadable baseline printed "No contract baseline" and exited 0. The Skills send the design
     * Agent here to read the ids it must address; that answer would have it declare every element as
     * ADDED against a baseline that already records them, and find out at archive.
     */
    return {
      ok: false,
      data: { contractsPath: project.contractsPath, domains: [], elementCount: 0 },
      diagnostics: unreadable(error, project.contractsPath, 'The contract baseline could not be read'),
    };
  }
  /* An absent directory is not an error and not an empty answer dressed as one: a project that has
     never archived a contract delta has no baseline, which is the ordinary state of most projects. */
  const files = (await fg('**/*.md', { cwd: directory, onlyFiles: true, followSymbolicLinks: false })).sort();
  let elementCount = 0;
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(path.join(directory, file), 'utf8');
    } catch (error) {
      /* One unreadable domain does not make the others unreportable, and it does not get to pass as
         a domain that records nothing either. The listing continues and says which one it lost. */
      diagnostics.push(...unreadable(error, `${project.contractsPath}/${file}`, 'A contract baseline domain could not be read'));
      continue;
    }
    const elements: Array<{ id: string; kind: string; module: string }> = [];
    /*
     * The `## Elements` section only, which is the same reading `core/contract-merger.ts` uses.
     *
     * Scanning the whole file found headings the merger does not: one left outside the section by a
     * hand-seeded baseline, or carried in a trailing `## ` section. Those listed here as addressable
     * ids, and a MODIFIED delta written against one was refused at merge with "the baseline does not
     * record it" -- on the archive path, after the closing approval, which is the exact route
     * `validateContractMergeFeasibility` exists to close.
     */
    const section = elementsSection(content);
    const headers = [...section.masked.matchAll(/^### Element:\s*(.+?)\s*$/gm)];
    for (const [index, match] of headers.entries()) {
      const id = match[1]!.trim();
      if (options.kind && kindOf(id) !== options.kind) continue;
      const body = section.text.slice(match.index!, headers[index + 1]?.index ?? section.text.length);
      elements.push({
        id,
        kind: kindOf(id),
        module: moduleOf(body),
      });
    }
    elementCount += elements.length;
    /* A domain filtered down to nothing is still listed. "This domain records no openapi element"
       and "this domain does not exist" are different answers, and a `--kind` filter that silently
       dropped the first would be read as the second. */
    domains.push({ domain: file.replace(/\.md$/, ''), path: `${project.contractsPath}/${file}`, elements });
  }
  return { ok: true, data: { contractsPath: project.contractsPath, domains, elementCount }, diagnostics };
}

export function renderContractListText(result: ContractListResult): string {
  const lines: string[] = [];
  if (result.data.domains.length === 0) {
    lines.push(`No contract baseline under ${result.data.contractsPath}. It is written by archiving a Change whose Flow sets syncContracts.`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(`CONTRACT BASELINE ${result.data.contractsPath} — ${result.data.elementCount} element(s)`);
  for (const domain of result.data.domains) {
    lines.push('');
    lines.push(`${domain.domain} (${domain.path})`);
    if (domain.elements.length === 0) lines.push('  (no element matches)');
    for (const element of domain.elements) {
      lines.push(`  ${element.id}${element.module ? `  — module ${element.module}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}


/**
 * What every Change in flight says it is about to do to the baseline.
 *
 * This is the one question the control plane is structurally unable to answer. `contentRevision` is
 * computed per Change, over that Change's own directory and its Flow -- so two Changes can each be
 * entirely compliant, each carry a human approval, and each say something different about the same
 * interface, and nothing anywhere compares them. Cross-Change consistency was never in the judgement
 * set, and no Gate can put it there: a Gate runs inside one Change and sees one Change.
 *
 * Reporting only, with no `ok: false` and no block. Two Changes naming the same element is not
 * automatically wrong -- one may be the expand half and the other the contract half of a planned
 * migration, deliberately sequenced -- and a CLI that refused it would be deciding a question it
 * cannot see the answer to. What it can do is make sure nobody finds out at merge time.
 *
 * It reads the deltas and stops there. The baseline they will merge into is checked per Change by
 * `validateContractMergeFeasibility`, and re-checked at archive against whatever the baseline says
 * by then, which is the only moment the answer is not provisional.
 */
interface ContractStatusResult {
  ok: boolean;
  data: {
    changes: Array<{
      change: string;
      elements: Array<{ id: string; operation: string; module: string }>;
    }>;
    overlaps: Array<{
      id: string;
      claims: Array<{ change: string; operation: string }>;
    }>;
  };
  diagnostics: Diagnostic[];
}

export async function executeContractStatus(project: ProjectContext): Promise<ContractStatusResult> {
  const diagnostics: Diagnostic[] = [];
  /*
   * The same reading `state` uses for "in flight": every directory that is not the archive and not
   * a dotfile. An archived Change has already merged and is not competing for anything.
   *
   * An empty `changes` list is this command's whole answer -- "no Change in flight declares a
   * contract delta" is the sentence an operator reads to conclude that nothing collides. A
   * directory that could not be read must not be allowed to produce it.
   */
  const inFlight = await listChangeDirectories(project);
  if (inFlight.unreadable) {
    return {
      ok: false,
      data: { changes: [], overlaps: [] },
      diagnostics: [diagnostic(
        'XFORGE_CHANGES_DIRECTORY_UNREADABLE',
        `The Changes directory could not be read (${inFlight.unreadable}), so no claim on the baseline can be reported. This is not "no conflicts".`,
        project.changesPath,
      )],
    };
  }
  const ids = inFlight.ids;

  const changes: ContractStatusResult['data']['changes'] = [];
  const claims = new Map<string, Array<{ change: string; operation: string }>>();
  for (const id of ids) {
    const directory = await safeResolve(project.root, `${project.changesPath}/${id}/contracts`);
    const files = (await fg('**/*.md', { cwd: directory, onlyFiles: true, followSymbolicLinks: false })).sort();
    if (files.length === 0) continue;
    const elements: Array<{ id: string; operation: string; module: string }> = [];
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(path.join(directory, file), 'utf8');
      } catch (error) {
        /* Same reading as the listing: a delta that could not be opened is reported, never counted
           as a Change that claims nothing -- which is the answer this command exists to give. */
        diagnostics.push(...unreadable(error, `${project.changesPath}/${id}/contracts/${file}`, 'A contract delta could not be read'));
        continue;
      }
      for (const section of parseContractDelta(content).sections) {
        for (const element of section.elements) {
          elements.push({
            id: element.id,
            operation: section.operation,
            module: moduleOf(element.content),
          });
          claims.set(element.id, [...(claims.get(element.id) ?? []), { change: id, operation: section.operation }]);
        }
      }
    }
    /* Listed even with no element: a Change that holds a delta asserting "(none)" everywhere has
       said something, and leaving it out would read as a Change that never looked. */
    changes.push({ change: id, elements });
  }

  /* Counted by distinct Change, not by claim. One Change naming an id in two of its own domain files
     appended twice, and the result announced "claimed by more than one Change" about one Change --
     a statement that is false about the only fact this command exists to report. */
  const overlaps = [...claims.entries()]
    .filter(([, entries]) => new Set(entries.map((entry) => entry.change)).size > 1)
    .map(([id, entries]) => ({ id, claims: entries }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { ok: diagnostics.length === 0, data: { changes, overlaps }, diagnostics };
}

export function renderContractStatusText(result: ContractStatusResult): string {
  const lines: string[] = [];
  if (result.data.changes.length === 0) {
    lines.push('No Change in flight declares a contract delta.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`CONTRACT DELTAS IN FLIGHT — ${result.data.changes.length} Change(s)`);
  for (const entry of result.data.changes) {
    lines.push('');
    lines.push(`${entry.change}${entry.elements.length === 0 ? '  (declares no element)' : ''}`);
    for (const element of entry.elements) {
      lines.push(`  ${element.operation.padEnd(8)} ${element.id}${element.module ? `  — module ${element.module}` : ''}`);
    }
  }
  lines.push('');
  if (result.data.overlaps.length === 0) {
    lines.push('No element is claimed by more than one Change in flight.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`CLAIMED BY MORE THAN ONE CHANGE — ${result.data.overlaps.length} element(s)`);
  lines.push('Not necessarily wrong: an expand and a contract half of one migration look like this.');
  lines.push('It is checked here because whichever Change archives second finds out at merge time.');
  for (const overlap of result.data.overlaps) {
    lines.push('');
    lines.push(`  ${overlap.id}`);
    for (const claim of overlap.claims) lines.push(`    ${claim.operation.padEnd(8)} ${claim.change}`);
  }
  return `${lines.join('\n')}\n`;
}
