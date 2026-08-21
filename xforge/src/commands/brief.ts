import type { BriefData, BriefItem, BriefResult } from '../core/brief.js';
import { readBrief } from '../core/brief.js';
import { safeResolve } from '../core/path-safety.js';
import type { ProjectContext } from '../types.js';
import { loadYaml } from '../core/yaml.js';

export interface BriefCommandOptions {
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

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    /* A CJK-heavy line has few spaces, so word wrapping alone would emit one enormous line. Long
       words are placed on their own line rather than broken: cutting mid-token would corrupt a
       Requirement id, and this text is quoted so that ids stay greppable. */
    if (current && `${current} ${word}`.length > width) {
      lines.push(indent + current);
      current = word;
      continue;
    }
    current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(indent + current);
  return lines;
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
 */
export function renderBriefText(data: BriefData): string {
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
    lines.push('  These name no Stage to return to, so nothing sends them back: they close when you answer them.');
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
  lines.push('EXTRACTED — verbatim from the Artifacts, located by headings the Flow declares.');
  renderItems(data.extracted, lines);

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
