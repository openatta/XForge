import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDiagnosticCatalogue, rawCallCount, renderCatalogue, renderCatalogueLocations, splitArguments } from '../../src/core/diagnostics-catalogue.js';
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
    const sites = await readDiagnosticCatalogue(xforgeRoot);
    /*
     * Only the direct sites, because only those are `diagnostic(` calls. The catalogue also carries
     * codes a module declares as data and hands to `diagnostic()` elsewhere — `doctor`'s
     * suggestions, the control plane's blocks, the reconciliation rules — and counting those against
     * a raw scan for `diagnostic(` would compare two different things.
     */
    const direct = sites.filter((site) => site.severity !== 'indirect');
    expect(direct.length).toBe(await rawCallCount(xforgeRoot));
    expect(direct.length).toBeGreaterThan(180);
    expect(direct.every((site) => site.message.length > 0 && site.file.startsWith('src/'))).toBe(true);
    /*
     * Eight call sites choose their code at runtime — `cli.ts`'s unknown-versus-missing command, the
     * Gate runner forwarding a declared Gate's own refusal, four remedy diagnostics that carry a
     * code decided by what they are remedying, and the two in `core/reconcile.ts`: one forwards the
     * code a reconciliation rule decided, the other the code the reader of an unreadable source
     * produced. They are legitimate and invisible to the wording rules below, so the fingerprint
     * records them as `(dynamic)`: a ninth appearing shows up as a diff there rather than as a
     * silent gap in the catalogue. The count is asserted here so it cannot grow by way of a golden
     * update that nobody reads.
     */
    expect(sites.filter((site) => site.code === null).length).toBe(8);

    /*
     * And the indirect ones, counted so they cannot quietly grow either. Forty-five declarations carrying thirty-five distinct codes reached
     * readers without ever appearing here: the fingerprint claimed to be every diagnostic this
     * product can emit and was missing a tenth of them, and the untested-code list below is built
     * from this catalogue — so it could not owe anything for a code it had never heard of.
     *
     * Fifty-two now, over forty-two codes: the contract work added the reconciliation rules, whose
     * observations carry their own code and reach a reader through the one forwarding site in
     * `core/reconcile.ts`; RC-8 added one, and `doctor`'s suggestions reach a reader the same
     * indirect way. That is the shape this count exists to keep visible.
     */
    const indirect = sites.filter((site) => site.severity === 'indirect');
    expect(indirect.length).toBe(52);
    expect(new Set(indirect.map((site) => site.code)).size).toBe(42);
  });

  it('splits arguments at top-level commas only', () => {
    /* The severity is positional, and the message before it routinely contains commas, nested
       calls and template literals — so this is the part of the parser most able to be quietly
       wrong. */
    expect(splitArguments(`'A', 'b, c', undefined, 'warning'`)).toEqual([`'A'`, `'b, c'`, 'undefined', `'warning'`]);
    expect(splitArguments("'A', `x ${f(1, 2)} y`, p, 'info'")).toEqual(["'A'", '`x ${f(1, 2)} y`', 'p', "'info'"]);
    expect(splitArguments("'A', join([1, 2]), undefined")).toEqual(["'A'", 'join([1, 2])', 'undefined']);
    /*
     * A template literal nested inside another one's `${}`. Tracking a single open quote read the
     * backtick that opens the inner one as the one that closes the outer, after which every comma
     * in the rest of the call separated an argument — so the severity landed in the wrong position
     * and the code was recorded as `dynamic`. Three messages here were written around it before
     * anybody noticed, which is what an unparsed argument list costs: nothing visible.
     */
    expect(splitArguments("'A', `x ${y ? `inner, comma` : ''} z`, p, 'warning'"))
      .toEqual(["'A'", "`x ${y ? `inner, comma` : ''} z`", 'p', "'warning'"]);
    /*
     * And a `${}` ends at the brace matching its own, not at the first one. The first version of the
     * fix above popped on the `}` closing a destructured parameter, which ended the template early
     * and turned a real call site — `XFORGE_VERIFICATION_RETIRE_AMBIGUOUS` — into one the catalogue
     * recorded as carrying no path.
     */
    expect(splitArguments("'A', `x ${list.map(({ entry }) => entry).join(', ')} y`, p, 'error'"))
      .toEqual(["'A'", "`x ${list.map(({ entry }) => entry).join(', ')} y`", 'p', "'error'"]);
    /*
     * And an expression holds regex literals. `${p.replace(/^specs\//, '')}` carries `\/` followed
     * by `/`, which a comment rule reads as the start of a line comment and skips the rest of the
     * line for — silently truncating a real call site's argument list. `XFORGE_SPEC_MERGE_CONFLICT`
     * was the one it happened to.
     */
    expect(splitArguments("'A', `x ${p.replace(/^specs\\//, '')} y`, q, 'error'"))
      .toEqual(["'A'", "`x ${p.replace(/^specs\\//, '')} y`", 'q', "'error'"]);
  });

  it('matches the recorded fingerprint', async () => {
    /* Code, severity, locatability — what a reader of the output experiences. Deliberately without
       the module, so that moving a call site is not a change to this. */
    const { actual, expected } = await golden('diagnostics/catalogue.txt', renderCatalogue(await readDiagnosticCatalogue(xforgeRoot)));
    expect(actual).toBe(expected);
  });

  it('records where each code is raised, as an index that is expected to move', async () => {
    const { actual, expected } = await golden('diagnostics/catalogue-locations.txt', renderCatalogueLocations(await readDiagnosticCatalogue(xforgeRoot)));
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
    const offenders = (await readDiagnosticCatalogue(xforgeRoot))
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
    const offenders = (await readDiagnosticCatalogue(xforgeRoot))
      .filter((site) => !site.hasPath && namesAFile.test(site.message))
      .map((site) => `${site.code ?? '(dynamic)'} ${site.file}`);
    /*
     * Recorded rather than asserted empty: this is a debt list that may only shrink, and the golden
     * makes each removal visible instead of letting the number drift upward unnoticed.
     *
     * It grew by sixteen once, and that growth was the list becoming honest rather than the coverage
     * getting worse. The catalogue this is built from could not see a code a module declares as data
     * and hands to `diagnostic()` elsewhere, so thirty-four such codes — `doctor`'s suggestions, the
     * control plane's blocks, the reconciliation rules — were never candidates for it. Sixteen of
     * them had no test. They had never had one; the list simply could not say so.
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
    const sites = await readDiagnosticCatalogue(xforgeRoot);
    const codes = [...new Set(sites.map((site) => site.code).filter((code): code is string => Boolean(code)))].sort();

    const asserted = new Set<string>();
    /** Patterns a test applies to `.code`, which cover every code they match. */
    const patterns: string[] = [];
    for (const directory of [path.join(xforgeRoot, 'test'), path.join(repositoryRoot, 'tests')]) {
      for await (const source of readTestSources(directory)) {
        /*
         * Comments stripped first. The scan counted any occurrence of a code, so naming one in a
         * comment -- which good test prose does constantly, to say what a case is about -- marked it
         * as covered. The list then reported coverage nobody had written, which is the one thing a
         * debt list must not do. Removing them lengthens the list once, and every entry it adds was
         * always untested.
         */
        const code = withoutComments(source);
        for (const match of code.matchAll(/XFORGE_[A-Z0-9_]+/g)) asserted.add(match[0]);
        /*
         * A test may hold a whole family of codes to one rule rather than naming each member.
         * `text-form-readability` asserts that *every* `XFORGE_RECONCILE_*` diagnostic reaches the
         * readable form; `output-sinks` does the same for every `*UNREADABLE*`. Those are stronger
         * assertions than a list of literals — a code added to the family is covered the day it is
         * written, where a literal list would have to be remembered — and the scan counted them as
         * covering nothing, so twelve codes sat in the debt list that the suite already checked.
         *
         * Only patterns applied to `.code` count. A regex used for anything else says nothing about
         * which diagnostics a test verifies.
         */
        for (const match of code.matchAll(/\/([^/\n]{3,}?)\/\s*\.test\(\s*(?:[A-Za-z_][A-Za-z0-9_]*)\.code/g)) {
          patterns.push(match[1]!);
        }
        for (const match of code.matchAll(/\.code\s*\.\s*(?:startsWith|includes)\(\s*'([^']+)'/g)) {
          patterns.push(match[1]!);
        }
      }
    }
    const untested = codes.filter((code) => !asserted.has(code)
      && !patterns.some((pattern) => { try { return new RegExp(pattern).test(code); } catch { return false; } }));

    /*
     * A golden rather than a threshold. A number would let one code be covered while another goes
     * dark and the total stay flat; the list makes both directions visible, and a pull request that
     * lengthens it has to say why in its diff.
     */
    /*
     * A hundred and seventy-nine entries nobody can act on is a number, not a debt list. Grouped by
     * the prefix a code carries, it becomes a reading: which *area* of the product the suite has
     * never exercised, and therefore where a bug would arrive unannounced. `WORK` at forty-odd says
     * something a flat list cannot.
     */
    const byArea = new Map<string, number>();
    for (const code of untested) {
      const area = code.replace(/^XFORGE_/, '').split('_')[0] ?? 'OTHER';
      byArea.set(area, (byArea.get(area) ?? 0) + 1);
    }
    const summary = [...byArea].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([area, count]) => `${String(count).padStart(4)}  ${area}`);
    const { actual: areas, expected: areasExpected } = await golden('diagnostics/untested-by-area.txt', `${summary.join('\n')}\n`);
    expect(areas).toBe(areasExpected);

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
