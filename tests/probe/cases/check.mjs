import { readFile } from 'node:fs/promises';
import { parse } from '../../../xforge/node_modules/yaml/dist/index.js';
import { assert as genericAssert, changePath, prepare as genericPrepare } from './_generic.mjs';

/**
 * The Check Stage, measured on its own.
 *
 * Success is not "a file appeared". It is the three things a Check Agent is supposed to do and has
 * been observed not doing: write the report to the shape its Flow declares, put its findings in the
 * ledger that governs, and keep its opinion out of the prose.
 *
 * The first two are what every Stage owes, so they come from `_generic.mjs` — which also removes
 * the Flow name this file used to hardcode. Reading `major.yaml` by name was harmless while
 * `major-check` was the only fixture in existence and would have judged a `solid` fixture against
 * another Flow's outline the moment a second one was captured.
 */

export const prepare = genericPrepare;

export async function assert(context) {
  const checks = await genericAssert(context);
  const { projectRoot, change } = context;

  let report = '';
  try { report = await readFile(changePath(projectRoot, change, 'check-report.md'), 'utf8'); } catch { return checks; }

  /* The verdict belongs in the ledger, which is what the Stage exit actually reads. Prose that also
     announces one competes with the record that governs, and the two can disagree. */
  const verdictHeadings = report.split(/\r?\n/)
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim())
    .filter((heading) => /verdict|approval state/i.test(heading));
  checks.push({ name: 'states no verdict in prose', ok: verdictHeadings.length === 0, detail: verdictHeadings });

  /*
   * A blocker with nowhere to go back to.
   *
   * `check-findings` is what the Stage exit decides on, and a blocker is required to name the Stage
   * it sends the work to. A live major run recorded blockers and the Flow routed on them correctly;
   * the case that would go unnoticed is a blocker with `reworkTo` missing, because the ledger still
   * parses and the Stage still refuses to exit — with nothing saying where the work should land.
   */
  let findings = null;
  try { findings = parse(await readFile(changePath(projectRoot, change, 'evidence', 'check-findings.yaml'), 'utf8')); } catch { /* below */ }
  const entries = Array.isArray(findings?.findings) ? findings.findings : null;
  checks.push({
    name: 'records findings in the ledger',
    ok: entries !== null,
    detail: entries ? `${entries.length} finding(s)` : 'no readable ledger',
  });
  if (entries) {
    const homeless = entries
      .filter((entry) => entry?.severity === 'blocker' && entry?.status !== 'resolved' && !entry?.reworkTo)
      .map((entry) => entry?.id ?? '(unidentified)');
    checks.push({ name: 'every open blocker names a reworkTo Stage', ok: homeless.length === 0, detail: homeless });
  }
  return checks;
}
