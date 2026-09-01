import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

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

interface DiagnosticSite {
  /** The literal code, or null where the first argument is not a string literal. */
  code: string | null;
  /** As passed, defaulting to `error` exactly as `core/errors.ts` does. */
  severity: 'error' | 'warning' | 'info' | 'dynamic' | 'indirect';
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
  /*
   * A stack of frames, not one `quote` character.
   *
   * A template literal can contain `${...}`, and what is inside that is ordinary code — including
   * another template literal. Tracking a single open quote made the scanner treat the backtick that
   * *opens* a nested template as the one that *closes* the outer one, after which every comma in the
   * rest of the call read as an argument separator. The symptom was a severity silently lost, and
   * three messages in this codebase were written around it before it was found.
   *
   * An interpolation frame carries its own brace depth, which the first version of this fix did not:
   * `${matches.map(({ entry }) => …)}` closes a destructured parameter before it closes the
   * interpolation, and popping on that `}` ended the template early — turning a three-argument call
   * into something that read as having no path. A `${}` ends at the brace that matches its own, not
   * at the first one.
   */
  type Frame = { quote: "'" | '"' | '`' } | { interpolation: true; braces: number };
  const stack: Frame[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    const top = stack[stack.length - 1];

    if (top && 'quote' in top && top.quote !== '`') {
      current += char;
      if (char === '\\') { current += next ?? ''; index += 2; continue; }
      if (char === top.quote) stack.pop();
      index += 1;
      continue;
    }
    if (top && 'quote' in top) {
      current += char;
      if (char === '\\') { current += next ?? ''; index += 2; continue; }
      if (char === '$' && next === '{') { current += next; stack.push({ interpolation: true, braces: 0 }); index += 2; continue; }
      if (char === '`') stack.pop();
      index += 1;
      continue;
    }

    /* Outside a string, or inside a `${}` where code rules apply again. */
    if (char === '"' || char === "'" || char === '`') { stack.push({ quote: char }); current += char; index += 1; continue; }
    if (top && 'interpolation' in top) {
      /*
       * No comment detection in here, and `\` consumes the character after it.
       *
       * A `${}` holds an expression, and an expression holds regex literals:
       * `${relative.replace(/^specs\//, '')}` contains `\/` followed by `/`, which a `//` rule reads
       * as the start of a line comment and skips the rest of the line for. That silently truncated
       * one real call site's argument list. A `//` comment inside a template interpolation is legal
       * and essentially never written, so not looking for one costs nothing and removes the misfire.
       */
      if (char === '\\') { current += char + (next ?? ''); index += 2; continue; }
      if (char === '{') top.braces += 1;
      else if (char === '}') {
        if (top.braces === 0) { stack.pop(); current += char; index += 1; continue; }
        top.braces -= 1;
      }
      current += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
    if (char === '/' && next === '*') { index = source.indexOf('*/', index) + 2; continue; }
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0 && stack.length === 0) { args.push(current.trim()); current = ''; index += 1; continue; }
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
/**
 * Files that contain the text `diagnostic(` and no call to it.
 *
 * `core/errors.ts` declares the function and the `Diagnostic` type. This module names it in prose
 * and in the regex it scans with — it began life in `test/` and moved here so one implementation
 * could serve the build, the command and the suite, and the move made it visible to itself.
 */
function notACallSite(file: string): boolean {
  return file.endsWith(`core${path.sep}errors.ts`) || file.endsWith(`core${path.sep}diagnostics-catalogue.ts`);
}

async function sourceFiles(xforgeRoot: string): Promise<string[]> {
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
export async function rawCallCount(xforgeRoot: string): Promise<number> {
  let total = 0;
  for (const file of await sourceFiles(xforgeRoot)) {
    const source = await readFile(file, 'utf8');
    if (notACallSite(file)) continue;
    total += [...source.matchAll(/(?<![A-Za-z0-9_.])diagnostic\(/g)].length;
  }
  return total;
}

/**
 * Codes a module names as data and hands to `diagnostic()` somewhere else.
 *
 * `core/reconcile/rules.ts` builds observations carrying `code: 'XFORGE_RECONCILE_…'`, and
 * `core/reconcile.ts` emits them with `diagnostic(observation.code, …)`. The call site is real and
 * the code is real; only the *join* between them is indirect, so a scan for literal first arguments
 * saw a `(dynamic)` call and no codes at all.
 *
 * Eleven codes escaped the catalogue that way — and with it the untested-code debt list, which is
 * built from the catalogue and therefore could not owe anything for a code it had never heard of.
 * Recorded as `indirect`: this says the product can emit them, and does not claim a severity the
 * declaration does not carry.
 */
function indirectCodes(source: string, file: string): DiagnosticSite[] {
  const found: DiagnosticSite[] = [];
  for (const match of source.matchAll(/(?:^|[\s{,])code:\s*'(XFORGE_[A-Z0-9_]+)'/gm)) {
    found.push({
      code: match[1]!,
      severity: 'indirect',
      hasPath: false,
      /*
       * The `summary` beside it, which is the sentence the reader will actually meet.
       *
       * This was the empty string, and `xforge explain` prints what the catalogue holds -- so every
       * one of these codes explained itself as nothing at all, against the `xforge-apply` Skill's
       * promise that explain "gives that code's severity and every message it can carry". A live run
       * asked about one and got a blank. The text is a template with `${...}` still in it, because
       * the values are computed; a reader learns far more from the shape than from silence, and the
       * interpolations are where the specifics go.
       */
      message: nearbySummary(source, match.index! + match[0].length),
      file,
      line: source.slice(0, match.index!).split('\n').length,
    });
  }
  return found;
}

/**
 * The `summary:` template that follows a `code:` in the same object literal.
 *
 * Bounded to the next few hundred characters and to a single template literal: past that the search
 * leaves the observation it started in and reports a neighbour's sentence, which is worse than
 * reporting none.
 */
function nearbySummary(source: string, from: number): string {
  const window = source.slice(from, from + 900);
  /* `summary` in a reconciliation observation, `message` everywhere else -- both name the sentence
     the reader meets, and quoting either is a template literal or a plain string. */
  /* `(?:[^`\\]|\\.)*` rather than `[^`]*`: these messages quote CLI syntax with escaped backticks
     inside them, and stopping at the first one returned a fragment or nothing at all. */
  const match = /\b(?:summary|message):\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/.exec(window);
  if (!match) return '';
  return match[1]!.slice(1, -1).replace(/\\`/g, '`').replace(/\s*\n\s*/g, ' ').trim();
}

export async function readDiagnosticCatalogue(xforgeRoot: string): Promise<DiagnosticSite[]> {
  const sites: DiagnosticSite[] = [];
  for (const file of await sourceFiles(xforgeRoot)) {
    /* Its own definition and the `Diagnostic` type live here; neither is a call site. */
    if (notACallSite(file)) continue;
    const source = await readFile(file, 'utf8');
    const relative = path.relative(xforgeRoot, file).split(path.sep).join('/');
    sites.push(...indirectCodes(source, relative));
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
 * The behavioural fingerprint: what each code is, not where it lives.
 *
 * Code, severity, and whether it can be located — the three things a reader of the output actually
 * experiences. Deduplicated and sorted, so that moving or duplicating a call site is not a change to
 * this while adding, dropping or re-severing a code is. Where each one is raised is recorded
 * separately by `renderCatalogueLocations`.
 */
export function renderCatalogue(sites: DiagnosticSite[]): string {
  const lines = [...new Set(sites.map((site) => `${site.code ?? '(dynamic)'}  ${site.severity}  ${site.hasPath ? 'path' : 'no-path'}`))];
  return `${lines.sort((left, right) => left.localeCompare(right)).join('\n')}\n`;
}

/**
 * Where each code is raised, recorded apart from what it does.
 *
 * The two were one file and the file column defeated the fingerprint's own purpose: moving a call
 * site between modules -- which a structural refactor does constantly -- re-recorded a list whose
 * every behavioural entry was unchanged, and a signature that fires on movement is one people learn
 * to re-record without reading. What a reader experiences is the code, its severity and whether it
 * can be located; that is the fingerprint. Which module raises it is an index, useful and expected
 * to move.
 */
export function renderCatalogueLocations(sites: DiagnosticSite[]): string {
  const lines = [...new Set(sites.map((site) => `${site.code ?? '(dynamic)'}  ${site.file}`))];
  return `${lines.sort((left, right) => left.localeCompare(right)).join('\n')}\n`;
}
