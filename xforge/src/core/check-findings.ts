import { access, readFile } from 'node:fs/promises';
import type { ProjectContext } from '../types.js';
import { knownIdentities, unknownIdentityReason, unverifiableIdentityWarning, type KnownIdentities } from './ledger-identity.js';
import { unknownKeyWarnings, verdict, type LedgerVerdict } from './ledger.js';
import { safeResolve } from './path-safety.js';
import { loadYaml, trimmedText } from './yaml.js';

/**
 * The machine-decidable half of a Check report.
 *
 * `check-report.md` is narrative: an Agent grading its own review prose is exactly the
 * "Agent PASS is not a Gate" pattern XForge forbids elsewhere, and it was the last place a Stage
 * could be exited on self-assessment alone. This ledger carries the part a Gate can actually
 * decide — whether any blocking finding is still open, and whether each one names where it must be
 * reworked. It deliberately mirrors the material-questions ledger so both conditions read the same.
 *
 * Two additional checks mirror the other governance ledgers in this codebase
 * (`core/control-plane.ts`'s exit conditions, `core/constitution-check.ts`'s violations):
 *
 * - A blocker flipped to `status: resolved` must name a `resolvedBy` identity that matches a known
 *   approver or Git author (see `core/ledger-identity.ts`). A resolution nobody can be held to is not
 *   a resolution — an unattributed or unrecognized `resolvedBy` keeps the blocker counted as open,
 *   the same failure-closed posture the other two ledgers take.
 * - Each `refs` entry is checked for existence in the Change directory. This is deliberately the
 *   minimal form of cross-artifact consistency: it proves the cited path is real, not that its
 *   content actually supports the finding. A dangling ref is a quality issue, not proof the finding
 *   is wrong, so it is reported as a warning that does not fail the Gate.
 */
export const CHECK_FINDINGS_PATH = 'evidence/check-findings.yaml';

type FindingSeverity = 'blocker' | 'warning' | 'suggestion';

interface CheckFinding {
  id?: unknown;
  severity?: unknown;
  summary?: unknown;
  refs?: unknown;
  status?: unknown;
  reworkTo?: unknown;
  resolvedBy?: unknown;
}

interface CheckFindingsLedger {
  findings?: unknown;
}

interface CheckFindingsResult extends LedgerVerdict {
  counts: Record<FindingSeverity, number>;
  openBlockers: string[];
}

const SEVERITIES: FindingSeverity[] = ['blocker', 'warning', 'suggestion'];

/** Every key this evaluator reads, and the ones `xforge findings resolve` writes. */
const FINDING_KEYS = ['id', 'severity', 'summary', 'refs', 'status', 'reworkTo', 'resolvedBy', 'resolvedAt', 'answer'] as const;

/** Resolves a `refs` entry the same way other Change-relative Artifact paths are resolved. */
/**
 * Change-relative first, then project-relative -- the same two spellings `constitution-check`
 * accepts, and for the same reason.
 *
 * This tried one spelling. The two ledgers are written in the same Stage, by the same Skill, and
 * only the permissive one is written down: `xforge-check` says of the Constitution's `references`
 * that a path is "any path in the repository ... Do not confine yourself to Change-local paths",
 * and says nothing about this one. So a finding that cited `xforge/changes/<id>/design.md` -- the
 * form `xforge state` prints, and the form the work-package plan is *required* to use -- was told
 * it "does not exist in this Change" about a file plainly sitting there. Two separate hand-driven
 * runs hit it, and both ran the experiment before believing the message.
 *
 * The cost was not the warning. A finding must cite what motivated it, and the files that motivate
 * a coverage or gate-declaration finding are the immutable acceptance suite and the Manifest --
 * neither reachable Change-relative. Both runs had to reword findings to point somewhere weaker, or
 * accept a warning on the citation that carried the point.
 */
async function refExists(project: ProjectContext, changeId: string, ref: string): Promise<boolean> {
  for (const candidate of [`${project.changesPath}/${changeId}/${ref}`, ref]) {
    try {
      await access(await safeResolve(project.root, candidate));
      return true;
    } catch { /* try the next spelling */ }
  }
  return false;
}

async function evaluate(
  project: ProjectContext,
  changeId: string,
  document: CheckFindingsLedger,
  relative: string,
  known: KnownIdentities,
): Promise<CheckFindingsResult> {
  const counts: Record<FindingSeverity, number> = { blocker: 0, warning: 0, suggestion: 0 };
  const problems: string[] = [];
  const warnings: string[] = [];
  const openBlockers: string[] = [];
  /** Every `resolvedBy` this ledger asserts, so a pass reached without a way to check them can say so. */
  const resolvedNames: string[] = [];

  if (!Array.isArray(document.findings)) {
    return { ...verdict([`${relative}: expected a top-level "findings" list. Record an explicit empty list when the review found nothing.`], warnings), counts, openBlockers };
  }

  const seen = new Set<string>();
  for (const [index, raw] of document.findings.entries()) {
    const finding = (raw ?? {}) as CheckFinding;
    const label = trimmedText(finding.id) || `#${index + 1}`;
    /* Before anything is read off it: a key this evaluator does not know is a key it silently drops,
       and `resolveBy` for `resolvedBy` produces a finding that reads as resolved and counts as open. */
    warnings.push(...unknownKeyWarnings(raw, FINDING_KEYS, `${relative}: finding ${label}`));
    const id = trimmedText(finding.id);
    if (!id) problems.push(`${relative}: finding ${label} has no id.`);
    else if (seen.has(id)) problems.push(`${relative}: duplicate finding id ${id}.`);
    else seen.add(id);

    const severity = trimmedText(finding.severity) as FindingSeverity;
    if (!SEVERITIES.includes(severity)) {
      problems.push(`${relative}: finding ${label} has severity "${trimmedText(finding.severity) || '(none)'}"; expected one of ${SEVERITIES.join(', ')}.`);
      continue;
    }
    counts[severity] += 1;

    if (!trimmedText(finding.summary)) problems.push(`${relative}: finding ${label} has no summary.`);
    const refPaths = Array.isArray(finding.refs) ? finding.refs.map(trimmedText).filter(Boolean) : [];
    if (refPaths.length === 0) problems.push(`${relative}: finding ${label} cites no artifact; a finding nobody can locate cannot be acted on.`);
    for (const ref of refPaths) {
      if (!(await refExists(project, changeId, ref))) {
        warnings.push(`${relative}: finding ${label} refs "${ref}", which does not exist in this Change.`);
      }
    }

    if (severity !== 'blocker') {
      /*
       * A non-blocker marked resolved is reported, not enforced.
       *
       * Only a blocker's `resolvedBy` decides this Gate, and that stays true: promoting a warning's
       * attribution to a failure would refuse ledgers that were valid before this rule existed. But
       * "only blockers are checked" was invisible, and it is exactly the entries an approver is
       * asked to answer that are usually warnings — an approver's open questions are
       * built from findings with no `reworkTo`, at any severity. So an unattributed close on one of
       * those used to read the same as a checked one. `xforge findings resolve` writes an
       * attribution this can name; a hand edit may not, and now says so.
       */
      const status = trimmedText(finding.status) || 'open';
      if (status === 'resolved') {
        const resolvedBy = trimmedText(finding.resolvedBy);
        if (!resolvedBy) {
          warnings.push(`${relative}: ${severity} finding ${label} is marked resolved but names no resolvedBy. Only a blocker's attribution fails this Gate, so this is reported rather than refused.`);
        } else {
          resolvedNames.push(resolvedBy);
          const reason = unknownIdentityReason(resolvedBy, known);
          if (reason) warnings.push(`${relative}: ${severity} finding ${label} is resolved by "${resolvedBy}", which ${reason}. Only a blocker's attribution fails this Gate, so this is reported rather than refused.`);
        }
      }
      continue;
    }
    const status = trimmedText(finding.status) || 'open';
    if (status === 'resolved') {
      /* A resolution nobody can be held to does not count as one — same posture as the other ledgers. */
      const resolvedBy = trimmedText(finding.resolvedBy);
      if (!resolvedBy) {
        problems.push(`${relative}: blocking finding ${label} is marked resolved but names no resolvedBy; an unattributed resolution does not count as resolved.`);
        openBlockers.push(id || label);
      } else {
        resolvedNames.push(resolvedBy);
        const reason = unknownIdentityReason(resolvedBy, known);
        if (reason) {
          problems.push(`${relative}: blocking finding ${label} is resolved by "${resolvedBy}", which ${reason}.`);
          openBlockers.push(id || label);
        }
      }
      continue;
    }

    openBlockers.push(id || label);
    /* A blocker must say where the work goes back to, otherwise "blocked" is not actionable. */
    if (!trimmedText(finding.reworkTo)) problems.push(`${relative}: blocking finding ${label} does not name a reworkTo Stage.`);
  }

  if (openBlockers.length > 0) problems.push(`${relative}: ${openBlockers.length} blocking finding(s) still open: ${openBlockers.join(', ')}.`);
  /*
   * A pass that could not have failed says so. Every `resolvedBy` above was accepted against an
   * empty identity set, which is not the same fact as "these names check out", and the difference
   * becomes visible at the worst moment: the Change's first commit populates the set, and the same
   * ledger is then refused with the Check report already written.
   */
  const unverifiable = resolvedNames.length > 0 ? unverifiableIdentityWarning(known) : null;
  if (unverifiable) {
    warnings.push(`${relative}: ${resolvedNames.length} resolvedBy name(s) (${resolvedNames.join(', ')}) were accepted without verification — ${unverifiable}.`);
  }
  return { ...verdict(problems, warnings), counts, openBlockers };
}

export async function evaluateCheckFindings(project: ProjectContext, changeId: string, known?: KnownIdentities): Promise<CheckFindingsResult> {
  const relative = `${project.changesPath}/${changeId}/${CHECK_FINDINGS_PATH}`;
  const counts: Record<FindingSeverity, number> = { blocker: 0, warning: 0, suggestion: 0 };
  let absolute: string;
  try { absolute = await safeResolve(project.root, relative); }
  catch { return { ...verdict([`${relative}: path is outside the project.`]), counts, openBlockers: [] }; }
  try { await access(absolute); }
  catch {
    return { ...verdict([`${relative}: the Check Stage must record a machine-decidable findings ledger; narrative in check-report.md does not satisfy this Gate.`], []), counts, openBlockers: [] };
  }
  let document: CheckFindingsLedger;
  try { document = await loadYaml<CheckFindingsLedger>(absolute, relative); }
  catch (error) { return { ...verdict([`${relative}: ${(error as Error).message}`]), counts, openBlockers: [] }; }
  if (!document || typeof document !== 'object') {
    return { ...verdict([`${relative}: expected a YAML mapping.`]), counts, openBlockers: [] };
  }
  /* An empty file parses to null/'' upstream; treat a readable but contentless ledger as unusable. */
  if ((await readFile(absolute, 'utf8')).trim().length === 0) {
    return { ...verdict([`${relative}: the findings ledger is empty.`]), counts, openBlockers: [] };
  }
  /*
   * The caller's identity set when it has one, and Git authors alone when it does not.
   *
   * The fallback used to be the only path, justified as "Check runs ahead of any approval Stage, so
   * the only identities this ledger can hold are Git authors". True of the Check Stage and false of
   * the other time this Gate runs: it is mandatory on the archive path, where the Change's approval
   * receipts exist and name real people. A `resolvedBy` citing the person who signed the planning
   * approval was refused there by a message promising that approvers count.
   */
  const identities = known ?? (await knownIdentities(project, changeId, []));
  return evaluate(project, changeId, document, relative, identities);
}
