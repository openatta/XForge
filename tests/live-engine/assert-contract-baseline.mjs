import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The contract baseline moved, and moved to what the delta said.
 *
 * Reaching archive is not evidence of this. A Flow can declare a contract-delta Artifact, collect one
 * every Change, and merge none of them -- both halves individually valid, the baseline never
 * advancing, every Change re-declaring what the last already said. That was a real defect on this
 * branch, found by reading rather than by running, and it is invisible to an outcome check because
 * the Change archives perfectly either way.
 *
 * So the assertion is on the record: every element id the Change declared as ADDED has to be in the
 * baseline afterwards, and the delta itself has to have travelled into the archive rather than
 * vanishing. Read out of the archived Change's own delta, not out of a list this file holds, because
 * a fixture that names the ids stops testing whether the Agent addressed them correctly.
 */
export function assertContractBaselineAdvanced({ projectRoot, changeId, scenarioName }) {
  const archivedRoot = path.join(projectRoot, 'xforge', 'changes', 'archive');
  let archivedChange;
  try { archivedChange = readdirSync(archivedRoot).find((name) => name.endsWith(changeId)); }
  catch { throw new Error(`No archive directory at ${archivedRoot}.`); }
  if (!archivedChange) throw new Error(`No archived directory for ${changeId} under ${archivedRoot}.`);
  const archivedChangeDirectory = path.join(archivedRoot, archivedChange);
  const problems = [];
  const deltaRoot = path.join(archivedChangeDirectory, 'contracts');
  let deltaFiles = [];
  try { deltaFiles = readdirSync(deltaRoot).filter((name) => name.endsWith('.md')); }
  catch { problems.push(`The archived Change carries no contracts/ directory at ${deltaRoot}, so no interface delta travelled with it.`); }

  const declaredAdds = [];
  for (const file of deltaFiles) {
    let section = null;
    for (const line of readFileSync(path.join(deltaRoot, file), 'utf8').split('\n')) {
      const header = /^## (ADDED|MODIFIED|REMOVED) Contract Elements[ \t]*$/.exec(line);
      if (header) { section = header[1]; continue; }
      if (/^## /.test(line)) { section = null; continue; }
      const element = /^### Element:\s*(.+?)\s*$/.exec(line);
      if (section === 'ADDED' && element) declaredAdds.push(element[1].trim());
    }
  }
  if (deltaFiles.length > 0 && declaredAdds.length === 0) {
    problems.push('The interface delta declares no ADDED element, so this run proves nothing about a baseline advancing.');
  }

  const baselineRoot = path.join(projectRoot, 'xforge', 'contracts');
  let recorded = new Set();
  try {
    for (const file of readdirSync(baselineRoot).filter((name) => name.endsWith('.md'))) {
      const source = readFileSync(path.join(baselineRoot, file), 'utf8');
      for (const match of source.matchAll(/^### Element:\s*(.+?)\s*$/gm)) recorded.add(match[1].trim());
    }
  } catch { problems.push(`The contract baseline is missing or unreadable at ${baselineRoot}.`); }

  for (const id of declaredAdds) {
    if (!recorded.has(id)) problems.push(`The delta declared "${id}" as ADDED and the baseline does not record it after archive, so syncContracts did not merge.`);
  }
  if (problems.length > 0) {
    throw new Error(`${scenarioName} archived without advancing the contract baseline:\n  ${problems.join('\n  ')}`);
  }
  return { declaredAdds, recorded: [...recorded].sort() };
}
