import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { Diagnostic, ProjectContext } from '../types.js';
import { parseContractDelta } from '../core/contract-delta.js';
import { safeResolve } from '../core/path-safety.js';

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
    return { ok: false, data: { contractsPath: project.contractsPath, domains: [], elementCount: 0 }, diagnostics: (error as { diagnostics?: Diagnostic[] }).diagnostics ?? [] };
  }
  /* An absent directory is not an error and not an empty answer dressed as one: a project that has
     never archived a contract delta has no baseline, which is the ordinary state of most projects. */
  const files = (await fg('**/*.md', { cwd: directory, onlyFiles: true, followSymbolicLinks: false })).sort();
  let elementCount = 0;
  for (const file of files) {
    const content = await readFile(path.join(directory, file), 'utf8');
    const elements: Array<{ id: string; kind: string; module: string }> = [];
    const headers = [...content.matchAll(/^### Element:\s*(.+?)\s*$/gm)];
    for (const [index, match] of headers.entries()) {
      const id = match[1]!.trim();
      if (options.kind && kindOf(id) !== options.kind) continue;
      const body = content.slice(match.index!, headers[index + 1]?.index ?? content.length);
      elements.push({
        id,
        kind: kindOf(id),
        module: /^[ \t]*[-*+][ \t]+module:[ \t]*(\S.*)$/m.exec(body)?.[1]?.trim() ?? '',
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
  let changesRoot: string;
  try {
    changesRoot = await safeResolve(project.root, project.changesPath);
  } catch (error) {
    return { ok: false, data: { changes: [], overlaps: [] }, diagnostics: (error as { diagnostics?: Diagnostic[] }).diagnostics ?? [] };
  }
  /* The same reading `state` uses for "in flight": every directory that is not the archive and not
     a dotfile. An archived Change has already merged and is not competing for anything. */
  let ids: string[] = [];
  try {
    ids = (await readdir(changesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch { /* No Changes directory at all is an empty answer, not a failure. */ }

  const changes: ContractStatusResult['data']['changes'] = [];
  const claims = new Map<string, Array<{ change: string; operation: string }>>();
  for (const id of ids) {
    const directory = await safeResolve(project.root, `${project.changesPath}/${id}/contracts`);
    const files = (await fg('**/*.md', { cwd: directory, onlyFiles: true, followSymbolicLinks: false })).sort();
    if (files.length === 0) continue;
    const elements: Array<{ id: string; operation: string; module: string }> = [];
    for (const file of files) {
      const content = await readFile(path.join(directory, file), 'utf8');
      for (const section of parseContractDelta(content).sections) {
        for (const element of section.elements) {
          elements.push({
            id: element.id,
            operation: section.operation,
            module: /^[ \t]*[-*+][ \t]+module:[ \t]*(\S.*)$/m.exec(element.content)?.[1]?.trim() ?? '',
          });
          claims.set(element.id, [...(claims.get(element.id) ?? []), { change: id, operation: section.operation }]);
        }
      }
    }
    /* Listed even with no element: a Change that holds a delta asserting "(none)" everywhere has
       said something, and leaving it out would read as a Change that never looked. */
    changes.push({ change: id, elements });
  }

  const overlaps = [...claims.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([id, entries]) => ({ id, claims: entries }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { ok: true, data: { changes, overlaps }, diagnostics: [] };
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
