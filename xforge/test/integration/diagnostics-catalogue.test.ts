import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDiagnosticCatalogue, rawCallCount, renderCatalogue, renderCatalogueLocations, splitArguments } from '../diagnostics-catalogue.js';
import { golden } from '../golden.js';
import { repositoryRoot, xforgeRoot } from '../helpers.js';

/**
 * Everything this product can say, held to rules and to a recorded fingerprint.
 *
 * Two jobs. During the structural refactor the fingerprint is a behavioural signature: moving code
 * between modules must not add, drop or re-sever a single diagnostic, and this is what proves it.
 * Beyond that it is the standing catalogue test — the answer to "68% of the codes this product can
 * emit are asserted by no test", which is the measured form of the gap.
 */
describe('diagnostic catalogue', () => {
  it('parses every call site the source contains', async () => {
    /* The parser is load-bearing for every assertion below, so it is checked against a raw count
       first: one that silently skipped call sites would understate the catalogue and weaken the
       rules built on it without failing anything. */
    const sites = await readDiagnosticCatalogue();
    expect(sites.length).toBe(await rawCallCount());
    expect(sites.length).toBeGreaterThan(180);
    expect(sites.every((site) => site.message.length > 0 && site.file.startsWith('src/'))).toBe(true);
    /*
     * Six call sites choose their code at runtime — `cli.ts`'s unknown-versus-missing command, the
     * Gate runner forwarding a declared Gate's own refusal, and four remedy diagnostics that carry
     * a code decided by what they are remedying. They are legitimate and invisible to the wording
     * rules below, so the fingerprint records them as `(dynamic)`: a seventh appearing shows up as
     * a diff there rather than as a silent gap in the catalogue. The count is asserted here so it
     * cannot grow by way of a golden update that nobody reads.
     */
    expect(sites.filter((site) => site.code === null).length).toBe(6);
  });

  it('splits arguments at top-level commas only', () => {
    /* The severity is positional, and the message before it routinely contains commas, nested
       calls and template literals — so this is the part of the parser most able to be quietly
       wrong. */
    expect(splitArguments(`'A', 'b, c', undefined, 'warning'`)).toEqual([`'A'`, `'b, c'`, 'undefined', `'warning'`]);
    expect(splitArguments("'A', `x ${f(1, 2)} y`, p, 'info'")).toEqual(["'A'", '`x ${f(1, 2)} y`', 'p', "'info'"]);
    expect(splitArguments("'A', join([1, 2]), undefined")).toEqual(["'A'", 'join([1, 2])', 'undefined']);
  });

  it('matches the recorded fingerprint', async () => {
    /* Code, severity, locatability — what a reader of the output experiences. Deliberately without
       the module, so that moving a call site is not a change to this. */
    const { actual, expected } = await golden('diagnostics/catalogue.txt', renderCatalogue(await readDiagnosticCatalogue()));
    expect(actual).toBe(expected);
  });

  it('records where each code is raised, as an index that is expected to move', async () => {
    const { actual, expected } = await golden('diagnostics/catalogue-locations.txt', renderCatalogueLocations(await readDiagnosticCatalogue()));
    expect(actual).toBe(expected);
  });

  it('never gives a code that reports success a warning or error severity', async () => {
    /*
     * `XFORGE_APPROVAL_DRY_RUN_VALID` was `warning` while its message said the approval is
     * well-formed and nothing was written — a false alarm on the one command run in order to be
     * careful, and the reason a live run distrusted the whole rehearsal path. A severity that
     * contradicts its own message trains a reader to ignore the channel.
     *
     * Deliberately a narrow set of phrases. The obvious wording — "passed", "accepted",
     * "succeeded" — is this domain's *status vocabulary*: `A succeeded delivery requires
     * head_commit` is a refusal that happens to contain the word. A looser pattern flagged six
     * such messages and would have taught the next reader to widen the exclusion list rather than
     * fix anything. These phrases can only be a claim that the reported subject is fine.
     */
    const reassuring = /\b(is well-formed|nothing is wrong|no problems? (?:were |was )?found|nothing to fix|all (?:checks|gates) passed)\b/i;
    const offenders = (await readDiagnosticCatalogue())
      .filter((site) => site.severity === 'error' || site.severity === 'warning')
      .filter((site) => reassuring.test(site.message))
      .map((site) => `${site.code} (${site.severity}) ${site.file}:${site.line}`);
    expect(offenders).toEqual([]);
  });

  it('gives every code that names a file a path to that file', async () => {
    /*
     * A message that names a file and carries no `path` cannot be located by any consumer, and
     * `check` classifies a Change's own findings by whether their path sits inside the Change —
     * so a missing path also silently reclassifies a finding as project-level. One such case was
     * fixed in the Spec merger during this work.
     */
    const namesAFile = /`[^`]*\.(?:yaml|yml|json|md|ts)`|\b[a-z0-9_-]+\/[a-z0-9_./-]+\.(?:yaml|yml|json|md)\b/i;
    const offenders = (await readDiagnosticCatalogue())
      .filter((site) => !site.hasPath && namesAFile.test(site.message))
      .map((site) => `${site.code ?? '(dynamic)'} ${site.file}`);
    /*
     * Recorded rather than asserted empty: this is a debt list that may only shrink, and the golden
     * makes each removal visible instead of letting the number drift upward unnoticed.
     *
     * Without the line number, on the same reasoning as the catalogue above: the first refactor to
     * delete nine lines from `project-loader.ts` moved both entries and failed this, reporting a
     * change to a debt list whose content was identical. A fingerprint that fires on code movement
     * is one people learn to re-record without reading.
     */
    const { actual, expected } = await golden('diagnostics/messages-without-path.txt', `${offenders.sort().join('\n')}\n`);
    expect(actual).toBe(expected);
  });

  it('records which codes no test asserts, as a list that may only shrink', async () => {
    const sites = await readDiagnosticCatalogue();
    const codes = [...new Set(sites.map((site) => site.code).filter((code): code is string => Boolean(code)))].sort();

    const asserted = new Set<string>();
    for (const directory of [path.join(xforgeRoot, 'test'), path.join(repositoryRoot, 'tests')]) {
      for await (const source of readTestSources(directory)) {
        /*
         * Comments stripped first. The scan counted any occurrence of a code, so naming one in a
         * comment -- which good test prose does constantly, to say what a case is about -- marked it
         * as covered. The list then reported coverage nobody had written, which is the one thing a
         * debt list must not do. Removing them lengthens the list once, and every entry it adds was
         * always untested.
         */
        for (const match of withoutComments(source).matchAll(/XFORGE_[A-Z0-9_]+/g)) asserted.add(match[0]);
      }
    }
    const untested = codes.filter((code) => !asserted.has(code));

    /*
     * A golden rather than a threshold. A number would let one code be covered while another goes
     * dark and the total stay flat; the list makes both directions visible, and a pull request that
     * lengthens it has to say why in its diff.
     */
    const { actual, expected } = await golden('diagnostics/untested-codes.txt', `${untested.join('\n')}\n`);
    expect(actual).toBe(expected);
  });
});

/** Block and line comments removed, leaving string literals intact — those are the assertions. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Test sources only — `.tmp` holds a full copy of an installed CLI from live-engine runs. */
async function* readTestSources(directory: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.name === '.tmp' || entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* readTestSources(absolute);
    else if (/\.(ts|mjs)$/.test(entry.name)) yield await readFile(absolute, 'utf8');
  }
}
