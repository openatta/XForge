import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '../../../xforge/node_modules/yaml/dist/index.js';

/**
 * The Check Stage, measured on its own.
 *
 * Success is not "a file appeared". It is the three things a Check Agent is supposed to do and has
 * been observed not doing: write the report to the shape its Flow declares, put its findings in the
 * ledger that governs, and keep its opinion out of the prose.
 */

const changePath = (projectRoot, change, ...rest) => path.join(projectRoot, 'xforge', 'changes', change, ...rest);

/** Remove the Artifact under test, so the Stage has a reason to produce it. */
export async function prepare({ projectRoot, change }) {
  await rm(changePath(projectRoot, change, 'check-report.md'), { force: true });
}

export async function assert({ projectRoot, change, repositoryRoot }) {
  const checks = [];
  const reportPath = changePath(projectRoot, change, 'check-report.md');

  let report = '';
  try { report = await readFile(reportPath, 'utf8'); } catch { /* reported below */ }
  checks.push({ name: 'writes check-report.md', ok: report.length > 0, detail: reportPath });
  if (!report) return checks;

  const flowText = await readFile(path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'flows', 'major.yaml'), 'utf8');
  const flow = parse(flowText);
  const outline = flow.artifacts.find((entry) => entry.id === 'check-report').outline;
  const declared = outline.split(/\r?\n/).filter((line) => line.trim().startsWith('## ')).map((line) => line.trim().slice(3).trim());
  const written = report.split(/\r?\n/).filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim());

  const missing = declared.filter((heading) => !written.includes(heading));
  const extra = written.filter((heading) => !declared.includes(heading));
  /* Omission and invention are separate results. A missing section breaks whatever is keyed to it;
     an invented one means the Agent had something to say and nowhere declared to say it, which is
     a statement about the Flow rather than about the Agent. */
  checks.push({ name: 'no declared section omitted', ok: missing.length === 0, detail: missing });
  checks.push({ name: 'no section invented', ok: extra.length === 0, detail: extra });

  /* The verdict belongs in the ledger, which is what the Stage exit actually reads. */
  const verdictHeadings = written.filter((heading) => /verdict|approval state/i.test(heading));
  checks.push({ name: 'states no verdict in prose', ok: verdictHeadings.length === 0, detail: verdictHeadings });

  let findings = null;
  try { findings = parse(await readFile(changePath(projectRoot, change, 'evidence', 'check-findings.yaml'), 'utf8')); } catch { /* below */ }
  checks.push({
    name: 'records findings in the ledger',
    ok: Array.isArray(findings?.findings),
    detail: Array.isArray(findings?.findings) ? `${findings.findings.length} finding(s)` : 'no readable ledger',
  });
  return checks;
}
