import { access, readFile } from 'node:fs/promises';
import { parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import type { Diagnostic, FileChange, NextAction, ProjectContext } from '../types.js';
import { CHECK_FINDINGS_PATH } from '../core/check-findings.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { loadApprovalReceipts } from '../core/control-plane/receipts.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { sha256 } from '../core/hash.js';
import { knownIdentities, unknownIdentityReason, unverifiableIdentityWarning } from '../core/ledger-identity.js';
import { safeResolve } from '../core/path-safety.js';
import { assertManaged } from '../core/project-loader.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveWorkPackages } from '../core/work-packages.js';
import { VERIFICATION_RECEIPT_PATH } from '../core/verification-receipt.js';

/**
 * Records a person's answer to a Check finding, and marks it resolved.
 *
 * The gap this closes is an authority gap, not a convenience one. `xforge brief` prints, at every
 * Stage that collects an approval, that an open finding naming no `reworkTo` is cleared by
 * "recording the answer and setting the entry to `status: resolved`" — and after the Check Stage
 * ends, no governed actor can do that. `xforge-check` owns `evidence/check-findings.yaml` and only
 * runs at Check; `xforge-verify`'s Authority covers assurance and the verification receipt;
 * `xforge-revise`'s covers Proposal, Specs, Clarifications and Design and explicitly excludes the
 * Check report. So the instruction the CLI keeps printing had no executor, and a live run did the
 * only remaining thing: hand-edited the ledger at `ready-to-archive`, which cost a transition
 * repair, a Gate re-run, a re-drafted receipt and a voided approval.
 *
 * This is deliberately narrow, and does not open the ledger to CLI authorship in general:
 *
 * - **One transition only**, open to resolved, on an entry that already exists. There is no
 *   `findings add`, no re-opening, no severity change. Writing findings stays the Check Stage's job
 *   and stays hand-authored, on the same reasoning as `docs/internal/XFORGE_PRODUCT_SPEC.md` §5.9's refusal to
 *   implement CRUD for every resource.
 * - **The answer is required and is stored.** A `status: resolved` with nothing recorded about what
 *   was decided is the failure the whole ledger exists to prevent; a finding pointed at a person is
 *   closed by an answer, not by a flag.
 * - **`--by` is checked against identities the repository records**, using the same
 *   `core/ledger-identity.ts` reading the `check-findings` Gate applies to blockers. An Agent can
 *   cite a decision-maker; it cannot invent one. It still cannot make this call *for* anyone — the
 *   name and the answer come from the person, and the Skills say so, which is a textual guard here
 *   exactly as it is for `verification declare --by`.
 * - **It refuses where the write would be expensive rather than doing it quietly.** At
 *   `ready-to-archive` an Artifact write stales the closing receipt and voids the approval bound to
 *   it, so this stops and names the repair route instead of leaving the operator to discover it
 *   from `archive --dry-run`.
 * - **It says what it just invalidated.** Writing an Artifact moves the Change's content revision,
 *   which stales Gate Evidence and any verification receipt citing it. A command that moved a
 *   revision silently would be worse than the hand edit it replaces.
 */

interface FindingsResolveOptions {
  change: string;
  /** The `id` of the finding to resolve, as written in the ledger. */
  id: string;
  /** What was decided. Stored on the entry; a resolution with no answer is not one. */
  answer: string;
  /** The person who answered. Checked against approvers and Git authors this Change records. */
  by: string;
  dryRun: boolean;
}

function findingsSequence(document: Document.Parsed): YAMLSeq | null {
  const value = document.get('findings');
  /* `yaml`'s Document API keeps nodes rather than plain values, which is what makes an in-place
     edit possible without a round trip that would erase the ledger's comments. */
  return value && typeof value === 'object' && 'items' in (value as object) ? (value as YAMLSeq) : null;
}

function entryText(entry: YAMLMap, key: string): string {
  const value = entry.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export async function executeFindingsResolve(
  project: ProjectContext,
  options: FindingsResolveOptions,
): Promise<{ data: Record<string, unknown>; diagnostics: Diagnostic[]; changes: FileChange[]; nextActions: NextAction[] }> {
  assertManaged(project, 'findings resolve');
  if (!options.answer.trim()) {
    throw new XForgeError(diagnostic(
      'XFORGE_FINDINGS_ANSWER_REQUIRED',
      '--answer must not be empty. This entry names no Stage to send the work back to, which means somebody was asked a question; marking it resolved without recording what was decided closes the question and loses the answer.',
    ));
  }

  const relative = `${project.changesPath}/${options.change}/${CHECK_FINDINGS_PATH}`;
  const absolute = await safeResolve(project.root, relative);
  try { await access(absolute); }
  catch {
    throw new XForgeError(diagnostic(
      'XFORGE_FINDINGS_LEDGER_MISSING',
      `${relative} does not exist, so there is no finding to resolve. The Check Stage writes this ledger; a Flow without a Check Stage (quick) does not produce one.`,
      relative,
    ));
  }

  const resolved = await resolveChangeState(project, options.change);
  const resources = await loadSelectedResources(project);
  let currentStage: string | null = null;
  let contentRevision: string | null = null;
  if (isStageFlow(resolved.flow) && resolved.flow.governance) {
    const workPackages = await resolveWorkPackages(project, options.change, resolved.config, resources);
    const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config, { workPackages });
    currentStage = control.governance.currentStage;
    contentRevision = control.governance.revision.contentRevision;
  }

  /*
   * Refused, not performed. `ready-to-archive` is synthetic: the closing transition receipt is bound
   * to the content revision this write would move, so the write lands, `archive` then reports
   * `transition:ready-receipt-stale`, and the approval already given is void because an approval is
   * bound to what it was given for. Saying that here costs one message; discovering it costs the
   * repair.
   */
  if (currentStage === 'ready-to-archive') {
    throw new XForgeError(diagnostic(
      'XFORGE_FINDINGS_STAGE_CLOSED',
      `This Change is at ready-to-archive, where the findings ledger is bound to the closing transition receipt. Resolving ${options.id} here would stale that receipt and void the archive approval. Run \`xforge archive --change ${options.change} --dry-run\` to see the route back — it names \`xforge transition repair\` — or resolve the finding before the Stage that collects the closing approval.`,
      relative,
    ), { root: project.root });
  }

  const source = await readFile(absolute, 'utf8');
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new XForgeError(diagnostic('XFORGE_YAML_INVALID', `Invalid YAML: ${document.errors[0]!.message}`, relative));
  }
  const findings = findingsSequence(document);
  if (!findings) {
    throw new XForgeError(diagnostic('XFORGE_FINDINGS_LEDGER_INVALID', `${relative}: expected a top-level "findings" list.`, relative));
  }

  const entries = findings.items.filter((item): item is YAMLMap => Boolean(item) && typeof item === 'object' && 'get' in (item as object));
  const ids = entries.map((entry) => entryText(entry, 'id')).filter(Boolean);
  const target = entries.find((entry) => entryText(entry, 'id') === options.id);
  if (!target) {
    throw new XForgeError(diagnostic(
      'XFORGE_FINDINGS_ID_UNKNOWN',
      `${relative} has no finding with id ${options.id}. It records: ${ids.join(', ') || '(no ids)'}.`,
      relative,
    ));
  }

  /* Idempotence is not silence: re-running this must not overwrite somebody else's recorded answer
     with a second one, so an already-resolved entry is reported with who closed it. */
  if (entryText(target, 'status') === 'resolved') {
    throw new XForgeError(diagnostic(
      'XFORGE_FINDINGS_ALREADY_RESOLVED',
      `Finding ${options.id} is already resolved${entryText(target, 'resolvedBy') ? ` by ${entryText(target, 'resolvedBy')}` : ''}. Nothing was written. A decision that has changed is a new finding or a rework, not an overwrite of the record.`,
      relative,
    ));
  }

  const approvals = await loadApprovalReceipts(project, options.change);
  const known = await knownIdentities(project, options.change, approvals.receipts);
  const reason = unknownIdentityReason(options.by, known);
  if (reason) {
    throw new XForgeError(diagnostic(
      'XFORGE_FINDINGS_RESOLVER_UNKNOWN',
      `--by "${options.by}" ${reason}. Nothing was written. This is the same bar the check-findings Gate holds a blocker's resolvedBy to: a resolution nobody can be held to is not a resolution.`,
      relative,
    ));
  }

  const diagnostics: Diagnostic[] = [];
  const unverifiable = unverifiableIdentityWarning(known);
  if (unverifiable) {
    diagnostics.push(diagnostic(
      'XFORGE_FINDINGS_RESOLVER_UNVERIFIABLE',
      `"${options.by}" was accepted without verification — ${unverifiable}.`,
      relative,
      'warning',
    ));
  }

  const severity = entryText(target, 'severity');
  target.set('status', 'resolved');
  target.set('answer', options.answer.trim());
  target.set('resolvedBy', options.by);
  target.set('resolvedAt', new Date().toISOString());
  const next = document.toString();

  /*
   * The consequence, stated. `evidence/check-findings.yaml` is an Artifact in every Flow that
   * declares it, so it is an input to the content revision: this write stales every Gate's Evidence
   * and any verification receipt citing it. The Agent's next step is not "continue", it is "re-run
   * the Gates", and that is what the next action says.
   */
  const receiptExists = await (async () => {
    try { await access(await safeResolve(project.root, `${project.changesPath}/${options.change}/${VERIFICATION_RECEIPT_PATH}`)); return true; }
    catch { return false; }
  })();
  diagnostics.push(diagnostic(
    'XFORGE_FINDINGS_REVISION_MOVED',
    `Resolving ${options.id} rewrites an Artifact, which moves this Change's content revision${contentRevision ? ` (was ${contentRevision})` : ''}. Gate Evidence bound to the old revision is now stale${receiptExists ? ', and so is evidence/verification-receipt.yaml, which must be drafted again after the Gates re-run' : ''}.`,
    relative,
    'info',
  ));

  if (!options.dryRun) await atomicWrite(project.root, relative, next);

  const nextActions: NextAction[] = [{
    action: 'run-gates', type: 'gate', actor: 'main', status: 'ready',
    reason: 'The findings ledger moved the content revision; Gate Evidence must be re-run before it can be cited.',
    command: ['xforge', 'check', '--change', options.change],
  }];
  if (receiptExists) nextActions.push({
    action: 'draft-verification-receipt', type: 'governance', actor: 'main', status: 'blocked',
    reason: 'The existing verification receipt cites a superseded content revision.',
    command: ['xforge', 'verification', 'draft-receipt', '--change', options.change],
  });

  return {
    data: {
      change: options.change,
      finding: { id: options.id, severity: severity || null, status: 'resolved', resolvedBy: options.by, answer: options.answer.trim() },
      stage: currentStage,
      contentRevisionBefore: contentRevision,
      dryRun: options.dryRun,
      path: relative,
    },
    diagnostics,
    /* The plan, whether or not it was applied — `changes` describes what a command would do and
       `dryRun` says whether it did it. Reporting an empty plan under `--dry-run` reads as "this
       would change nothing", which is the opposite of true and the one thing a rehearsal must not
       say. `install --dry-run` and `verification declare --dry-run` have always answered this way. */
    changes: next === source ? [] : [{ action: 'modify', path: relative, digest: sha256(next), source: `findings:${options.id}` }],
    nextActions,
  };
}
