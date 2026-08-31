import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { Diagnostic, ProjectContext } from '../types.js';
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
