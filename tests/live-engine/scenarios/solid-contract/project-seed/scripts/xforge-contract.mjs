#!/usr/bin/env node
/*
 * What this project runs behind its four declared contract Gates.
 *
 * XForge understands no contract dialect and will not learn one. What it governs is a *record*:
 * `xforge/contracts/*.md` lists the elements this project's modules expose, addressed by the
 * `<kind>:<selector>` id a delta has to name, and that record advances only when a Change's
 * contract-delta is merged at archive. The dialect document — here `src/api/openapi.json` — lives
 * with the implementation and is what the service actually serves.
 *
 * So every check below is the same set arithmetic between two roots: the record, and the live
 * extraction. No breaking-change tool has to exist for a dialect for "the interface moved and nobody
 * declared it" to be decidable.
 *
 *   enumerate                    the implementation's elements, as JSON
 *   lint                         ids are well formed and unique
 *   compat    --change <id>      what actually moved, reconciled against what the delta declares
 *   drift     --change <id>      the same, minus what the delta declares — see the note on drift
 *   boundaries                   the declared dependency direction, checked against the imports
 *
 * Exit 0 passes the Gate, non-zero fails it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const BASELINE = 'xforge/contracts';
const IMPLEMENTATION = 'src/api/openapi.json';

const argOf = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

/* Canonical form, so reformatting the source cannot invent a modified element: keys sorted
   recursively and re-serialised without whitespace. The digest is over meaning, not bytes. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

/** The elements the implementation serves today. */
function implementationElements() {
  const document = JSON.parse(read(IMPLEMENTATION));
  const elements = [];
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      elements.push({ id: `openapi:paths.${route}.${method}`, digest: digest(operation) });
    }
  }
  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
    elements.push({ id: `openapi:components.schemas.${name}`, digest: digest(schema) });
    for (const [property, shape] of Object.entries(schema.properties ?? {})) {
      elements.push({ id: `openapi:components.schemas.${name}.properties.${property}`, digest: digest(shape) });
    }
  }
  return elements.sort((left, right) => left.id.localeCompare(right.id));
}

/** The elements the baseline records, read the way the CLI's own merger reads it. */
function baselineElements() {
  const root = path.join(ROOT, BASELINE);
  let files = [];
  try { files = readdirSync(root).filter((name) => name.endsWith('.md')); } catch { return []; }
  const elements = [];
  for (const file of files.sort()) {
    const source = readFileSync(path.join(root, file), 'utf8');
    /* The `## Elements` section only. A heading outside it is not something the merge can find, and
       listing it here would offer an id that is refused at archive. */
    const header = /^## Elements\s*$/m.exec(source);
    if (!header) continue;
    const bodyStart = source.indexOf('\n', header.index + header[0].length);
    const remainder = bodyStart < 0 ? '' : source.slice(bodyStart + 1);
    const next = /^## /m.exec(remainder);
    const body = next ? remainder.slice(0, next.index) : remainder;
    for (const match of body.matchAll(/^### Element:\s*(.+?)\s*$/gm)) elements.push({ id: match[1].trim() });
  }
  return elements.sort((left, right) => left.id.localeCompare(right.id));
}

/* The set arithmetic. A record carries no digest, so MODIFIED cannot be computed from it — what the
   record makes decidable is membership, which is what "an element appeared or vanished and nobody
   said so" needs. A digest-carrying record would add MODIFIED; it is not needed to catch the case
   this exists for, and inventing one here would be a second format nothing else reads. */
function membershipDiff(baseline, implementation) {
  const before = new Set(baseline.map((element) => element.id));
  const after = new Set(implementation.map((element) => element.id));
  return {
    added: [...after].filter((id) => !before.has(id)).sort(),
    removed: [...before].filter((id) => !after.has(id)).sort(),
  };
}

/** The ids this Change's contract-delta declares, by section. */
function declaredIn(changeId) {
  const root = path.join(ROOT, 'xforge/changes', changeId, 'contracts');
  let files = [];
  try { files = readdirSync(root).filter((name) => name.endsWith('.md')); } catch { return null; }
  const sections = { ADDED: [], MODIFIED: [], REMOVED: [] };
  for (const file of files.sort()) {
    let current = null;
    for (const line of readFileSync(path.join(root, file), 'utf8').split('\n')) {
      const header = /^## (ADDED|MODIFIED|REMOVED) Contract Elements[ \t]*$/.exec(line);
      if (header) { current = header[1]; continue; }
      if (/^## /.test(line)) { current = null; continue; }
      const element = /^### Element:\s*(.+?)\s*$/.exec(line);
      if (current && element) sections[current].push(element[1].trim());
    }
  }
  return sections;
}

function reconcile(changeId) {
  const declared = declaredIn(changeId);
  if (!declared) return [`No contract delta under xforge/changes/${changeId}/contracts/.`];
  const actual = membershipDiff(baselineElements(), implementationElements());
  const problems = [];
  const known = new Set(implementationElements().map((element) => element.id));
  for (const [section, ids] of [['ADDED', actual.added], ['REMOVED', actual.removed]]) {
    for (const id of ids) {
      if (!declared[section].includes(id)) problems.push(`${id} actually ${section.toLowerCase()}, and the contract delta does not declare it under ## ${section} Contract Elements.`);
    }
    for (const id of declared[section]) {
      if (!ids.includes(id)) problems.push(`The contract delta declares ${id} under ## ${section} Contract Elements, and the implementation does not show it there.`);
    }
  }
  for (const id of declared.MODIFIED) {
    if (!known.has(id)) problems.push(`The contract delta declares ${id} as MODIFIED, and the implementation exposes no such element.`);
  }
  return problems;
}

const command = process.argv[2];

if (command === 'enumerate') {
  process.stdout.write(`${JSON.stringify({ kind: 'openapi', elements: implementationElements() }, null, 2)}\n`);
  process.exit(0);
}

if (command === 'lint') {
  const elements = implementationElements();
  const problems = [];
  const seen = new Set();
  for (const element of elements) {
    if (seen.has(element.id)) problems.push(`duplicate contract element id: ${element.id}`);
    seen.add(element.id);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?:\S+$/.test(element.id)) problems.push(`not a contract element id: ${element.id}`);
  }
  console.log(`contract-lint: ${elements.length} element(s), ${problems.length} problem(s)`);
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (command === 'compat') {
  const changeId = argOf('--change');
  if (!changeId) { console.error('compat needs --change <id>.'); process.exit(2); }
  const actual = membershipDiff(baselineElements(), implementationElements());
  console.log(`contract-compat: ${actual.added.length} added, ${actual.removed.length} removed against the recorded baseline`);
  for (const id of actual.added) console.log(`  ADDED    ${id}`);
  for (const id of actual.removed) console.log(`  REMOVED  ${id}`);
  const problems = reconcile(changeId);
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (command === 'drift') {
  /*
   * Drift is measured against the baseline *as this Change declares it will be*.
   *
   * Nothing writes xforge/contracts/ during a Change — a delta is an Artifact and the merge belongs
   * to archive — so an implementation that correctly moved ahead of the record, with a delta that
   * correctly declares every element it moved, reads as drifted right up until archive. Subtracting
   * what the delta declares is what lets an honest Change leave Verify. After archive the record has
   * advanced and the subtraction is empty, which is the state this check is really asserting.
   */
  const changeId = argOf('--change');
  if (!changeId) { console.error('drift needs --change <id>.'); process.exit(2); }
  const declared = declaredIn(changeId) ?? { ADDED: [], MODIFIED: [], REMOVED: [] };
  const forgiven = new Set([...declared.ADDED, ...declared.MODIFIED, ...declared.REMOVED]);
  const actual = membershipDiff(baselineElements(), implementationElements());
  const drifted = [...actual.added, ...actual.removed].filter((id) => !forgiven.has(id));
  console.log(`contract-drift: ${forgiven.size} declared, ${drifted.length} undeclared disagreement(s)`);
  for (const id of drifted) console.error(`  ${id}`);
  process.exit(drifted.length === 0 ? 0 : 1);
}

if (command === 'boundaries') {
  /*
   * The dependency direction this project declared, checked against what its source actually does.
   * `api` may read `store`; `store` may not read `api`. A contract says what one module may assume
   * of another, and this says which module is allowed to assume anything at all.
   */
  const offenders = [];
  const walk = (relative) => {
    const absolute = path.join(ROOT, relative);
    let entries = [];
    try { entries = readdirSync(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) { walk(next); continue; }
      if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.js')) continue;
      const source = readFileSync(path.join(ROOT, next), 'utf8');
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (/(^|\/)\.\.\/api(\/|$)|src\/api/.test(match[1])) offenders.push(`${next} imports ${match[1]}`);
      }
    }
  };
  try { statSync(path.join(ROOT, 'src/store')); walk('src/store'); } catch { /* nothing to check */ }
  console.log(`module-boundaries: ${offenders.length} violation(s) of the declared direction api -> store`);
  for (const offender of offenders) console.error(`  ${offender}`);
  process.exit(offenders.length === 0 ? 0 : 1);
}

console.error(`Unknown subcommand: ${command ?? '(none)'}`);
process.exit(2);
