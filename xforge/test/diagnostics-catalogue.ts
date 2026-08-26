import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { xforgeRoot } from './helpers.js';

/**
 * Every `diagnostic(...)` this product can emit, read out of the source.
 *
 * The catalogue exists because the suite could not answer two questions it should have been able to
 * answer instantly: which of the things XForge can say has anybody ever tested, and does a code's
 * severity match what its message claims. Measured before this was written, 132 of 194 codes were
 * asserted by no test at all — the quantified form of "exception handling is under-tested" — and
 * one code whose message says nothing is wrong was `warning`, on the one command an Agent runs in
 * order to be careful.
 *
 * Deliberately a source scan rather than a runtime one. A code that can only be produced by a
 * condition nobody has reproduced is exactly the code this is looking for, so enumerating by
 * execution would omit precisely the interesting half.
 *
 * The extractor is a balanced-paren reader rather than a regular expression, because the argument
 * that carries the severity is positional and frequently sits behind a nested call or a template
 * literal. It is checked against a raw occurrence count in the test that uses it: a parser that
 * silently skips call sites would understate the catalogue and quietly weaken every assertion
 * built on it.
 */

export interface DiagnosticSite {
  /** The literal code, or null where the first argument is not a string literal. */
  code: string | null;
  /** As passed, defaulting to `error` exactly as `core/errors.ts` does. */
  severity: 'error' | 'warning' | 'info' | 'dynamic';
  /** Whether a project-relative path was supplied — the third positional argument. */
  hasPath: boolean;
  /** The message argument's source text, for rules that read what a code claims about itself. */
  message: string;
  file: string;
  line: number;
}

const SEVERITIES = new Set(['error', 'warning', 'info']);

/** Splits a call's argument list at top-level commas, respecting strings, comments and nesting. */
export function splitArguments(source: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (quote) {
      current += char;
      if (char === '\\') { current += next ?? ''; index += 2; continue; }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; current += char; index += 1; continue; }
    if (char === '/' && next === '/') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
    if (char === '/' && next === '*') { index = source.indexOf('*/', index) + 2; continue; }
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) { args.push(current.trim()); current = ''; index += 1; continue; }
    current += char;
    index += 1;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/** The text between the parentheses of the call starting at `open`, or null when unbalanced. */
function callBody(source: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '/' && next === '/') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
    if (char === '/' && next === '*') { index = source.indexOf('*/', index) + 1; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

function literal(argument: string | undefined): string | null {
  if (!argument) return null;
  const match = /^'([^']*)'$|^"([^"]*)"$/.exec(argument.trim());
  return match ? match[1] ?? match[2] ?? null : null;
}

/** Every `.ts` file under `src`, sorted, so the catalogue's order is stable across machines. */
async function sourceFiles(): Promise<string[]> {
  const root = path.join(xforgeRoot, 'src');
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.endsWith('.ts')) files.push(absolute);
    }
  }
  await walk(root);
  return files;
}

/** Raw `diagnostic(` occurrences, used to prove the parser above did not skip any. */
export async function rawCallCount(): Promise<number> {
  let total = 0;
  for (const file of await sourceFiles()) {
    const source = await readFile(file, 'utf8');
    if (file.endsWith(`core${path.sep}errors.ts`)) continue;
    total += [...source.matchAll(/(?<![A-Za-z0-9_.])diagnostic\(/g)].length;
  }
  return total;
}

export async function readDiagnosticCatalogue(): Promise<DiagnosticSite[]> {
  const sites: DiagnosticSite[] = [];
  for (const file of await sourceFiles()) {
    /* Its own definition and the `Diagnostic` type live here; neither is a call site. */
    if (file.endsWith(`core${path.sep}errors.ts`)) continue;
    const source = await readFile(file, 'utf8');
    const relative = path.relative(xforgeRoot, file).split(path.sep).join('/');
    for (const match of source.matchAll(/(?<![A-Za-z0-9_.])diagnostic\(/g)) {
      const open = match.index! + match[0].length - 1;
      const body = callBody(source, open);
      if (body === null) continue;
      const args = splitArguments(body);
      const severityLiteral = literal(args[3]);
      sites.push({
        code: literal(args[0]),
        severity: args[3] === undefined
          ? 'error'
          : severityLiteral && SEVERITIES.has(severityLiteral) ? severityLiteral as DiagnosticSite['severity'] : 'dynamic',
        hasPath: args[2] !== undefined && args[2] !== 'undefined',
        message: (args[1] ?? '').replace(/\s+/g, ' ').trim(),
        file: relative,
        line: source.slice(0, match.index!).split('\n').length,
      });
    }
  }
  return sites;
}

/**
 * The checked-in form: one line per call site, sorted by code then location.
 *
 * Sorted rather than source-ordered so that moving a call site within a file — which a structural
 * refactor does constantly — is not a fingerprint change, while adding, removing, or re-severing
 * one is.
 */
export function renderCatalogue(sites: DiagnosticSite[]): string {
  const lines = sites
    .map((site) => `${site.code ?? '(dynamic)'}  ${site.severity}  ${site.hasPath ? 'path' : 'no-path'}  ${site.file}`)
    .sort((left, right) => left.localeCompare(right));
  return `${lines.join('\n')}\n`;
}
