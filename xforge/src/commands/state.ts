export { readState as executeState } from '../core/state-reader.js';

/**
 * The readable form of `xforge state`.
 *
 * `--text` is documented as "the same result as readable text", and for every other command the
 * generic envelope delivers that: a short header and a small `data` object. `state` is the one
 * command where it does not. Its `data` is the whole resolved project — resources, targets,
 * installation ownership, every historical transition receipt — and at a governed Stage it prints
 * as roughly fifty kilobytes of JSON under `Data:`. Two things follow, and both were observed in a
 * live run:
 *
 * - Nobody reads it. It is offered as the human form and is not one.
 * - The envelope's `Next actions:` block sits *after* it. A run at `ready-to-archive` reported the
 *   exact `xforge approve` command to run, in that block, and the operator concluded the CLI had
 *   not told them — which cost a detour through `approve --dry-run` to recover a command that was
 *   already on screen, forty thousand characters up.
 *
 * So this renders the part a person is asking about and says plainly what it left out. Three rules
 * it keeps to:
 *
 * - **Presentation only.** The JSON envelope is untouched; `--text` changes what is printed and
 *   nothing else. Machine callers should not be reading this, and `--field` remains the addressed
 *   way to take one value.
 * - **Omissions are named.** A summary that quietly drops a section is at its most reassuring
 *   exactly where it is least entitled to be — the same failure `core/brief.ts` carries an
 *   `unavailable` list to avoid. The closing line names what is not here and how to get it.
 * - **No verdicts.** Every line below is a fact already in `data`, reformatted. Nothing here
 *   decides whether a Gate is good enough or a Change is ready; that is what `check`, `brief` and
 *   `archive --dry-run` are for.
 */

interface StateLike {
  project?: { name?: string; layout?: string; paths?: { specs?: { value?: string }; changes?: { value?: string } }; compatibility?: { mode?: string } };
  scaffold?: { version?: string; language?: string };
  activeChanges?: string[];
  changes?: string[];
  resources?: Record<string, unknown>;
  change?: ChangeLike | null;
}

interface ChangeLike {
  id?: string;
  path?: string;
  flow?: string;
  classification?: { risk?: string; security?: boolean; privacy?: boolean; publicApi?: boolean; dataMigration?: boolean };
  nextArtifact?: { id?: string; writePath?: string; outputPaths?: string[]; missingDependencies?: string[] } | null;
  archive?: { ready?: boolean; mandatoryGates?: string[] };
  workPackages?: { ready?: string[]; unattributedPaths?: string[]; packages?: Array<{ id?: string; status?: string }> } | null;
  mandatoryGateEvidence?: Array<{ gate?: string; status?: string | null; command?: string[] | null; currentContentRevision?: boolean | null; sourceFilesChangedSince?: number | null }>;
  governance?: {
    currentStage?: string;
    revision?: { contentRevision?: string | null; gitHead?: string | null };
    readyTransitions?: Array<{ to?: string; ready?: boolean; blockedBy?: string[] }>;
    pendingApprovals?: Array<{ policyId?: string; transition?: string; missing?: number; roles?: string[] }>;
    audit?: { chainValid?: boolean; eventCount?: number; remotePending?: number; coverageGaps?: string[] };
    rules?: Array<{ id?: string; severity?: string; coverage?: string[] }>;
  };
}

/** Wraps on spaces at `width`, so a long resource list does not become one unreadable line. */
function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
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

function list(values: readonly string[] | undefined, empty = '(none)'): string {
  return values && values.length > 0 ? values.join(', ') : empty;
}

export function renderStateText(data: unknown): string {
  const state = (data ?? {}) as StateLike;
  const lines: string[] = [];
  const project = state.project ?? {};
  lines.push(`Project: ${project.name ?? '(unnamed)'} (${project.layout ?? 'unknown layout'}) — scaffold ${state.scaffold?.version ?? '?'} ${state.scaffold?.language ?? ''}`.trimEnd());
  lines.push(`  Specs: ${project.paths?.specs?.value ?? '?'}    Changes: ${project.paths?.changes?.value ?? '?'}    Compatibility: ${project.compatibility?.mode ?? '?'}`);
  lines.push(`  Active Changes: ${list(state.activeChanges)}`);

  /*
   * The selected resources, by kind. Printed rather than folded into the omissions line because
   * `--kind` exists to ask this exact question — `xforge state --kind gates --text` that answered
   * with a summary of everything except the gates would be a worse text form than the JSON dump it
   * replaced, not a better one.
   */
  const resources = Object.entries(state.resources ?? {});
  if (resources.length > 0) {
    lines.push('  Selected resources:');
    for (const [kind, value] of resources) {
      const names = Array.isArray(value)
        ? value.map((entry) => (entry && typeof entry === 'object' && 'id' in (entry as Record<string, unknown>) ? String((entry as { id: unknown }).id) : String(entry)))
        : [];
      lines.push(...wrap(`${kind} (${names.length}): ${names.join(', ') || '(none)'}`, 92, '    '));
    }
  }

  const change = state.change ?? null;
  if (!change) {
    lines.push('');
    lines.push('No Change selected. Pass --change <id> for its Stage, Gates, transitions and approvals.');
    return `${lines.join('\n')}\n${omissions(false)}`;
  }

  const governance = change.governance;
  lines.push('');
  lines.push(`CHANGE ${change.id ?? '?'} — flow ${change.flow ?? '?'}, stage ${governance?.currentStage ?? '(ungoverned)'}`);
  const classification = change.classification ?? {};
  const impacts = (['security', 'privacy', 'publicApi', 'dataMigration'] as const).filter((key) => classification[key]);
  lines.push(`  Risk ${classification.risk ?? '?'}; declared impacts: ${list(impacts)}`);
  if (governance?.revision) lines.push(`  Content revision: ${governance.revision.contentRevision ?? '(none)'}    Git head: ${governance.revision.gitHead ?? '(unknown)'}`);

  if (change.nextArtifact) {
    const target = change.nextArtifact.outputPaths?.length ? change.nextArtifact.outputPaths.join(', ') : change.nextArtifact.writePath ?? '(path not resolved)';
    lines.push(`  Next Artifact: ${change.nextArtifact.id ?? '?'} → ${target}`);
    const missing = change.nextArtifact.missingDependencies ?? [];
    if (missing.length > 0) lines.push(`    Blocked on: ${missing.join(', ')}`);
  }

  /* The Evidence facts, not a verdict: what ran, whether it is bound to today's content, and how
     far the tree has moved since. `state-reader.ts` collects these for exactly this reading. */
  if (change.mandatoryGateEvidence?.length) {
    lines.push('  Mandatory Gate Evidence:');
    for (const gate of change.mandatoryGateEvidence) {
      const drift = gate.sourceFilesChangedSince === null || gate.sourceFilesChangedSince === undefined
        ? 'drift unknown'
        : `${gate.sourceFilesChangedSince} source file(s) changed since`;
      const bound = gate.currentContentRevision === null || gate.currentContentRevision === undefined
        ? 'binding unknown'
        : gate.currentContentRevision ? 'current content revision' : 'STALE content revision';
      lines.push(`    ${gate.gate ?? '?'}: ${gate.status ?? 'no evidence'} — ${bound}, ${drift}`);
      if (gate.command) lines.push(`      ran: ${gate.command.join(' ')}`);
    }
  }

  if (change.workPackages) {
    const packages = change.workPackages.packages ?? [];
    const byStatus: Record<string, number> = {};
    for (const item of packages) byStatus[item.status ?? 'unknown'] = (byStatus[item.status ?? 'unknown'] ?? 0) + 1;
    lines.push(`  Work packages: ${packages.length} (${Object.entries(byStatus).map(([status, count]) => `${status} ${count}`).join(', ') || 'none'}); ready now: ${list(change.workPackages.ready)}`);
    const unattributed = change.workPackages.unattributedPaths ?? [];
    if (unattributed.length > 0) lines.push(`    Unattributed changed paths: ${unattributed.join(', ')}`);
  }

  if (governance) {
    lines.push('  Transitions available:');
    const transitions = governance.readyTransitions ?? [];
    if (transitions.length === 0) {
      /* `ready-to-archive` is synthetic and absent from `flow.stages`, so it legitimately offers
         none. Reported as the fact it is, because an empty list read as a stuck Change once. */
      lines.push(`    (none — Stage ${governance.currentStage ?? '?'} declares no legal target)`);
    }
    for (const transition of transitions) {
      lines.push(`    → ${transition.to ?? '?'}: ${transition.ready ? 'ready' : `blocked by ${list(transition.blockedBy)}`}`);
    }
    const pending = governance.pendingApprovals ?? [];
    lines.push(pending.length === 0 ? '  Approvals pending: (none)' : '  Approvals pending:');
    for (const approval of pending) {
      lines.push(`    ${approval.policyId ?? '?'} for ${approval.transition ?? '?'} — ${approval.missing ?? '?'} more approver(s), roles ${list(approval.roles, 'any')}`);
    }
    const audit = governance.audit ?? {};
    lines.push(`  Audit: chain ${audit.chainValid ? 'valid' : 'INVALID'}, ${audit.eventCount ?? 0} events, ${audit.remotePending ?? 0} awaiting remote delivery, coverage gaps: ${list(audit.coverageGaps)}`);
    /* Only the ones that report a problem with their own enforcement; listing every applicable Rule
       here would restore the wall of text this exists to remove. */
    const unenforced = (governance.rules ?? []).filter((rule) => (rule.coverage ?? []).some((entry) => entry === 'uncovered' || entry === 'unenforceable'));
    for (const rule of unenforced) lines.push(`  Rule ${rule.id ?? '?'} (${rule.severity ?? '?'}): ${list(rule.coverage)}`);
  }

  return `${lines.join('\n')}\n${omissions(true)}`;
}

function omissions(hasChange: boolean): string {
  const sections = hasChange
    ? 'targets and installation ownership, every Artifact entry, the full transition and approval receipt history, and the Constitution/Rules context block'
    : 'targets, installation ownership, Flow summaries and per-Change detail';
  return [
    '',
    `Not shown here: ${sections}.`,
    'Drop --text for the complete envelope, or address one value with --field (for example --field change.governance.revision.contentRevision).',
    'The blocks below are the envelope\'s own, unchanged.',
  ].join('\n');
}
