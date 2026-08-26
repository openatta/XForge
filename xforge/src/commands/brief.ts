import type { BriefData, BriefItem, BriefResult } from '../core/brief.js';
import { readBrief } from '../core/brief.js';
import { safeResolve } from '../core/path-safety.js';
import type { ProjectContext } from '../types.js';
import { loadYaml } from '../core/yaml.js';
import { wrap } from '../protocol/render.js';

interface BriefCommandOptions {
  change: string;
  /** Path to a YAML or JSON file of triage entries; see `validateTriage`. */
  attachTriage?: string;
}

export async function executeBrief(project: ProjectContext, options: BriefCommandOptions): Promise<BriefResult> {
  let triage: unknown;
  if (options.attachTriage) {
    /* YAML is a superset of JSON, so one reader accepts both spellings, and its diagnostics name
       the offending file the same way every other ledger's do. */
    triage = await loadYaml<unknown>(await safeResolve(project.root, options.attachTriage), options.attachTriage);
  }
  return readBrief(project, { change: options.change, triage });
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '(none)';
    if (value.every((entry) => typeof entry === 'string' || typeof entry === 'number')) return value.join(', ');
    return JSON.stringify(value);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '(none)';
  return entries.map(([key, entry]) => `${key}=${typeof entry === 'object' && entry !== null ? JSON.stringify(entry) : String(entry)}`).join('  ');
}

function renderItems(items: BriefItem[], lines: string[]): void {
  let group: string | null = null;
  for (const entry of items) {
    if (entry.group !== group) {
      group = entry.group;
      lines.push(`  [${group}]`);
    }
    const location = entry.path ? `  (${entry.path}:${entry.line})` : '';
    const value = renderValue(entry.value);
    if (value.length + entry.label.length < 96 && !value.includes('\n')) {
      lines.push(`    ${entry.label}: ${value}${location}`);
      continue;
    }
    lines.push(`    ${entry.label}:${location}`);
    lines.push(...wrap(value, 92, '      '));
  }
}

/**
 * The readable form.
 *
 * The three layers are printed in separate blocks and never interleaved. That is the whole point
 * of carrying provenance in the data: a reader who wants to know whether a line was checked or
 * merely asserted should be able to tell from where it sits on the page, without trusting the
 * wording. `--text` changes presentation only — the JSON carries exactly the same entries.
 *
 * `compact` folds the EXTRACTED block, and folds is the operative word: the quoted text is the
 * layer that keeps an approver from signing on computed summaries alone, so it is never dropped
 * silently. What replaces it names every heading that was quoted, the file and line it came from,
 * and the command that prints it in full — an omission the reader can see and reverse, rather than
 * one they have to detect. Three things it deliberately does not do:
 *
 * - It does not touch `data`. The JSON carries every `extracted` entry either way, so triage
 *   anchoring (`XFORGE_BRIEF_UNANCHORED_CLAIM`, which requires each authored entry to cite a
 *   `computed`/`extracted` id *that exists in this brief*) decides on the same set it always did.
 *   A folded brief with `--attach-triage` behaves exactly like an unfolded one.
 * - It does not fold the decision block, COMPUTED, RECONCILIATION, UNAVAILABLE or NOT COVERED.
 *   Those are what the approval turns on.
 * - It is not mentioned in any Skill. The Skills tell an Agent to run `xforge brief --text` and
 *   relay the output verbatim; leaving this flag out of them keeps the choice of how much a person
 *   sees with the person, which is the whole reason the quoted layer exists.
 */
export function renderBriefText(data: BriefData, options: { compact?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Decision brief — ${data.change} @ ${data.stage} (flow: ${data.flow})`);
  if (data.contentRevision) lines.push(`Content revision: ${data.contentRevision}`);

  if (!data.decision.applicable) {
    lines.push('');
    lines.push(`No decision here: ${data.decision.reason}`);
    return `${lines.join('\n')}\n`;
  }

  lines.push('');
  lines.push(`WHAT IS BEING DECIDED: ${data.decision.reason}`);
  for (const approval of data.decision.approvals) {
    lines.push(`  ${approval.policyId} for ${approval.transition} — ${approval.minApprovers} approver(s), roles ${approval.roles.join('/') || '(any)'}, separation of duties ${approval.separationOfDuties ? 'on' : 'off'}, still missing ${approval.missing}`);
  }
  for (const blocker of data.decision.openBlockers) lines.push(`  Open blocking finding: ${blocker}`);
  /* Printed with their text, not as bare ids: an approver who has to look up what CHK-010 was is
     an approver who will sign without looking it up. */
  for (const item of data.decision.awaitingDecision) {
    lines.push(`  Awaiting your answer: ${item.id} — ${item.summary}`);
  }
  if (data.decision.awaitingDecision.length > 0) {
    /* Naming the command, not just the outcome. The previous wording described the edit — set
       `status: resolved` — which after the Check Stage no Skill has the authority to make, so the
       instruction had no executor and the edit happened by hand at the worst possible moment. */
    lines.push('  These name no Stage to return to, so nothing sends them back. Record the answer with `xforge findings resolve --change <id> --id <finding-id> --answer <what you decided> --by <you>`; left open, they are reported at every later Stage. Doing it here is cheap: after the closing transition the same edit stales the receipt and voids the approval.');
  }

  lines.push('');
  lines.push('COMPUTED — derived from structured data; re-runs on the same revision are identical.');
  renderItems(data.computed, lines);

  lines.push('');
  lines.push('RECONCILIATION — differences between what a record claims and what the files contain.');
  lines.push('  These state a difference. They do not say it is a defect.');
  if (data.reconciliation.length === 0) lines.push('    (no differences found)');
  for (const observation of data.reconciliation) {
    lines.push(`    [${observation.rule}] ${observation.code}`);
    lines.push(...wrap(observation.summary, 92, '      '));
  }

  lines.push('');
  if (options.compact && data.extracted.length > 0) {
    lines.push(`EXTRACTED — folded: ${data.extracted.length} verbatim quote(s) are listed by heading, not printed.`);
    /* One line per source, headings joined: naming every quote is what makes this an omission the
       reader can see, and doing it per group is what keeps the fold shorter than the text it folds.
       Per-entry lines were not — on a Change with short sections they cost more than the quotes. */
    const sources = new Map<string, { path: string | undefined; labels: string[] }>();
    for (const entry of data.extracted) {
      const bucket = sources.get(entry.group) ?? { path: entry.path, labels: [] };
      bucket.labels.push(entry.label);
      sources.set(entry.group, bucket);
    }
    for (const [group, bucket] of sources) {
      lines.push(...wrap(`[${group}]${bucket.path ? ` ${bucket.path}` : ''} — ${bucket.labels.join(', ')}`, 92, '  '));
    }
    lines.push('  Print them with the same command without --compact — nothing above was computed from them.');
  } else {
    lines.push('EXTRACTED — verbatim from the Artifacts, located by headings the Flow declares.');
    renderItems(data.extracted, lines);
  }

  if (data.authored.length > 0) {
    lines.push('');
    lines.push('TRIAGE — written by a person or a model. Not a fact. Basis shown in brackets.');
    for (const entry of data.authored) {
      lines.push(`    ${entry.label}  [basis: ${(entry.basis ?? []).join(', ')}]`);
      if (typeof entry.value === 'string' && entry.value) lines.push(...wrap(entry.value, 92, '      '));
    }
  }

  if (data.unavailable.length > 0) {
    lines.push('');
    lines.push('UNAVAILABLE — sections this brief could not produce.');
    for (const entry of data.unavailable) lines.push(`    ${entry.section}: ${entry.reason} (${entry.code})`);
  }

  lines.push('');
  lines.push('NOT COVERED — what signing this brief does not mean you reviewed.');
  for (const entry of data.notCovered) lines.push(`    ${entry}`);

  return `${lines.join('\n')}\n`;
}
