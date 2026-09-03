import { readFile } from 'node:fs/promises';
import type { ChangeState, Diagnostic, GateEvidence, ProjectContext, StageFlow, TransitionReceipt } from '../../types.js';
import { unknownIdentityReason, type KnownIdentities } from '../ledger-identity.js';
import { diagnostic } from '../errors.js';
import { safeResolve } from '../path-safety.js';
import { evaluateVerificationReceipt, VERIFICATION_RECEIPT_CONDITION, VERIFICATION_RECEIPT_PATH } from '../verification-receipt.js';
import { readReviewAcknowledgements, reviewCovers } from '../review-acknowledgement.js';
import type { WorkPackageResolution } from '../work-packages.js';
import { parse as parseYaml } from 'yaml';

/**
 * Whether a Stage's declared exit conditions are satisfied, by the evidence on disk.
 *
 * A condition is a project's own gate on leaving a Stage, and the ledgers that answer them are
 * Agent-authored -- so every check here is failure-closed in the same way the Gates are: an entry
 * that names no decision-maker the repository records does not count as decided, and a condition
 * whose ledger cannot be read is not satisfied.
 *
 * Kept apart from the resolver because these are decisions about evidence, and the resolver is the
 * assembly that asks for them. A condition evaluator that could also read the Flow graph could
 * quietly answer a different question than the one the Stage declared.
 */

const CONDITION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
interface ConditionLedgerEntry {
  id?: unknown;
  question?: unknown;
  impact?: unknown;
  decision?: unknown;
  decidedBy?: unknown;
  decidedAt?: unknown;
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
/**
 * `null` when the entry is decided, otherwise why it is not.
 *
 * It returned a boolean, and the count of falses became `undecided-N` — a number and nothing else.
 * An end-to-end run met `undecided-4` over four entries whose every field was populated, could not
 * tell which four or why, and ended up reading this file to find out that `decidedBy` had failed an
 * identity check nothing had mentioned. The reason was computed here and dropped one line later.
 *
 * The `constitution-check` Gate hits the same check and says the whole of it, listing the names that
 * would have passed. That is the standard this now meets.
 */
function entryDecidedReason(entry: ConditionLedgerEntry, known?: KnownIdentities): string | null {
  for (const field of ['question', 'decision', 'decidedBy', 'decidedAt'] as const) {
    if (!nonEmptyString(entry[field])) return `has no ${field}`;
  }
  if (Number.isNaN(Date.parse(entry.decidedAt as string))) return `has a decidedAt that is not a date: "${entry.decidedAt as string}"`;
  /* A decision has to be attributable to somebody the repository has actually seen; a non-empty
     string let a live run get away with `decidedBy: XForge Live E2E`. */
  if (!known) return null;
  const unknown = unknownIdentityReason(entry.decidedBy as string, known);
  return unknown === null ? null : `is decided by "${entry.decidedBy as string}", which ${unknown}`;
}

function entryDecided(entry: ConditionLedgerEntry, known?: KnownIdentities): boolean {
  return entryDecidedReason(entry, known) === null;
}
/**
 * When this Stage's inputs were last re-opened, or null if they never were.
 *
 * Every other exit-decision input is bound to the content it speaks for: Gate Evidence and Approval
 * receipts carry a revision, `verificationReceipt` refuses on `content-revision-stale`, and
 * `independentReview` on `review-stale`. The conditions ledger was the one that carried nothing, so
 * a decision survived the content it was made against. A live Major run proved it: decide a material
 * question ("invalidate immediately, no grace period"), rework to Propose, rewrite the Proposal to
 * say the opposite, return to Clarify — and `condition:materialQuestions` was still satisfied, with
 * the overruled decision sitting untouched in the ledger. Clarify declares no Gates and no
 * Approvals, so that condition is its only blocker; vacuously satisfied, the whole Stage was a no-op
 * on every rework path.
 *
 * The ledger cannot name the revision it was decided against. Its own bytes are an Artifact output,
 * so they feed `contentRevision` (`core/revision.ts`) — a field stating that digest would change it
 * by being written, the fixed point `core/verification-receipt.ts` documents and sidesteps by not
 * being a content-governing Artifact. What is available instead is the transition chain, which is
 * digest-linked and cannot be rewritten: it records exactly when the Change went back past this
 * Stage. Entries decided before that moment were decided against inputs that have since re-opened.
 *
 * Two indices decide whether a receipt counts. It has to move *backwards* (`to` before `from`), and
 * it has to land at or before the Stage that owns the condition — a rework the owning Stage's inputs
 * cannot see is not staleness. For Major's Clarify (index 1) that admits `clarify -> propose`,
 * `design -> clarify` and `apply -> clarify`, and excludes `check -> design` and `apply -> design`,
 * neither of which touches the Proposal or the delta Specs its questions were decided against.
 *
 * The limit worth stating: this reaches entries, not an `entries: []` assertion. An empty list
 * asserts "nothing here was material" and carries no timestamp to compare, so a rework leaves it
 * standing. That is weaker than the entry case and deliberately not patched with a synthesized one.
 */
export function conditionReworkCutoff(flow: StageFlow, receipts: readonly TransitionReceipt[], stageId: string): number | null {
  const owning = flow.stages.findIndex((stage) => stage.id === stageId);
  if (owning < 0) return null;
  let cutoff: number | null = null;
  for (const receipt of receipts) {
    const from = flow.stages.findIndex((stage) => stage.id === receipt.from);
    const to = flow.stages.findIndex((stage) => stage.id === receipt.to);
    /* `to >= from` drops forward moves and self-transitions; `to > owning` drops a rework that lands
       after this Stage, whose inputs it therefore cannot have changed. */
    if (from < 0 || to < 0 || to >= from || to > owning) continue;
    const at = Date.parse(receipt.transitionedAt);
    if (Number.isNaN(at)) continue;
    if (cutoff === null || at > cutoff) cutoff = at;
  }
  return cutoff;
}
/**
 * Stage exit conditions are decided from a structured ledger, never from Artifact prose.
 *
 * The previous implementation regex-searched the Worker's own markdown for `<key>: <expected>`, so
 * an Agent could clear a governance condition by typing one line into a file it wrote itself --
 * exactly the "self-reported exit" that `xforge-apply` forbids as Gate Evidence. A condition now
 * requires `<change>/evidence/conditions/<key>.yaml` where every entry names a decision and a
 * decision maker, which cannot be satisfied without asserting an attributable human decision.
 */
async function evaluateExitCondition(
  project: ProjectContext,
  changeId: string,
  key: string,
  expected: string,
  known?: KnownIdentities,
  reworkCutoff?: number | null,
  diagnostics?: Diagnostic[],
): Promise<{ satisfied: boolean; reason: string }> {
  if (!CONDITION_KEY_PATTERN.test(key)) return { satisfied: false, reason: 'invalid-key' };
  let document: unknown = null;
  let found = false;
  for (const extension of ['yaml', 'yml', 'json']) {
    const relative = `${project.changesPath}/${changeId}/evidence/conditions/${key}.${extension}`;
    let source: string;
    try { source = await readFile(await safeResolve(project.root, relative), 'utf8'); }
    catch { continue; }
    found = true;
    try { document = extension === 'json' ? JSON.parse(source) : parseYaml(source, { strict: true, uniqueKeys: true }); }
    catch { return { satisfied: false, reason: 'ledger-unreadable' }; }
    break;
  }
  if (!found) return { satisfied: false, reason: `ledger-missing-expected-${expected}` };
  const ledger = document as { condition?: unknown; status?: unknown; entries?: unknown } | null;
  if (!ledger || typeof ledger !== 'object') return { satisfied: false, reason: 'ledger-unreadable' };
  if (nonEmptyString(ledger.condition) && ledger.condition !== key) return { satisfied: false, reason: 'ledger-subject-mismatch' };
  const entries = Array.isArray(ledger.entries) ? ledger.entries as ConditionLedgerEntry[] : null;
  if (!entries) return { satisfied: false, reason: 'entries-missing' };
  /*
   * An explicit `entries: []` is an assertion — "this Change raised no material questions" — and it
   * is the same assertion `core/check-findings.ts` accepts as `findings: []`, which this ledger was
   * written to mirror. Rejecting it stranded every Major Change that genuinely had nothing to
   * clarify: the clarify Stage declares no Gates and no Approvals, so `condition:materialQuestions`
   * is its only blocker, and the only way to clear it was to invent a question and attribute a
   * decision to a named human — the exact falsification the ledger exists to prevent.
   *
   * The absent and the empty case stay distinct, which is what makes the empty one an assertion
   * rather than an oversight: a missing file is still `ledger-missing-*`, an unreadable or
   * contentless one `ledger-unreadable`, and a ledger with no `entries` key at all `entries-missing`.
   * Only a list that is present and deliberately empty reaches the `status` check below.
   */
  const undecided = entries.filter((entry) => !entry || typeof entry !== 'object' || !entryDecided(entry, known));
  if (undecided.length > 0) {
    /*
     * `undecided-N` stays the block token — it is matched by prefix elsewhere, and a count is the
     * right shape for a machine. The sentence that says which entries and why goes beside it, so
     * the reader is not left counting.
     */
    if (diagnostics) {
      const named = entries.map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => !entry || typeof entry !== 'object' || !entryDecided(entry, known))
        .map(({ entry, index }) => {
          if (!entry || typeof entry !== 'object') return `entry ${index + 1} is not a mapping`;
          const id = nonEmptyString(entry.id) ? `"${entry.id as string}"` : `entry ${index + 1}`;
          return `${id} ${entryDecidedReason(entry, known)}`;
        });
      diagnostics.push(diagnostic(
        'XFORGE_CONDITION_LEDGER_UNDECIDED_REMEDY',
        `${undecided.length} of ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in \`evidence/conditions/${key}.yaml\` ${undecided.length === 1 ? 'is' : 'are'} not decided: ${named.join('; ')}. An entry counts as decided only when \`question\`, \`decision\`, \`decidedBy\` and \`decidedAt\` are all present, \`decidedAt\` parses as a date, and \`decidedBy\` names somebody this Change can attest — an approver on an approval receipt, or a Git author of the Change directory.`,
        `${project.changesPath}/${changeId}/evidence/conditions/${key}.yaml`,
        'warning',
      ));
    }
    return { satisfied: false, reason: `undecided-${undecided.length}` };
  }
  /*
   * Reached only by entries `entryDecided` already accepted, so `decidedAt` is present and parses.
   * An entry decided before the Change last went back past this Stage was decided against inputs
   * that have since been rewritten; re-affirming it means asking again and recording the new
   * `decidedAt`, which is the same act the field records in the first place.
   */
  if (typeof reworkCutoff === 'number') {
    const stale = entries.filter((entry) => Date.parse(entry.decidedAt as string) < reworkCutoff);
    if (stale.length > 0) {
      const named = stale.map((entry) => nonEmptyString(entry.id) ? entry.id.trim() : `#${entries.indexOf(entry) + 1}`);
      return { satisfied: false, reason: `stale-${named.join('+')}` };
    }
  }
  const declared = nonEmptyString(ledger.status) ? ledger.status.trim() : 'resolved';
  if (declared !== expected) return { satisfied: false, reason: `status-${declared}-expected-${expected}` };
  return { satisfied: true, reason: 'satisfied' };
}
/**
 * The one exit condition that is not decided from `evidence/conditions/<key>.yaml`.
 *
 * `verification-receipt` is required by all three shipped Flows, and until now its only check was
 * `core/flow-resolver.ts`'s "the file exists and is not empty" — so `echo x >
 * evidence/verification-receipt.yaml` closed the Verify Stage. That is the self-reported exit
 * `core/check-findings.ts` was written to eliminate, still standing in the last Stage before
 * archive. The receipt lives at its own Flow-declared path rather than under `evidence/conditions/`,
 * and it is decided against facts this resolve already holds (the content revision and the Gate
 * Evidence that actually passed), so it is routed here instead of through the generic ledger reader.
 */
async function evaluateVerificationReceiptCondition(
  project: ProjectContext,
  changeId: string,
  expected: string,
  contentRevision: string,
  gates: readonly GateEvidence[],
  diagnostics: Diagnostic[],
): Promise<{ satisfied: boolean; reason: string }> {
  const result = await evaluateVerificationReceipt(project, changeId, { contentRevision, gates });
  /*
   * The receipt reader reports a key nothing reads -- by name, with the nearest known key as a
   * suggestion -- and this was the one of the three evaluators not handed the diagnostics channel
   * its siblings use, so every one of those warnings was computed and dropped. A receipt carrying
   * an invented key was therefore accepted in silence, which is the whole reason the reader
   * computes them. They surface whether or not the condition is satisfied: a receipt that passes
   * while naming a field nobody reads is exactly the case worth saying out loud.
   */
  for (const warning of result.warnings ?? []) {
    diagnostics.push(diagnostic('XFORGE_VERIFICATION_RECEIPT_UNKNOWN_KEY', warning, `${project.changesPath}/${changeId}/${VERIFICATION_RECEIPT_PATH}`, 'warning'));
  }
  if (result.status !== 'passed') return { satisfied: false, reason: result.reason };
  if (expected !== 'passed') return { satisfied: false, reason: `status-passed-expected-${expected}` };
  return { satisfied: true, reason: 'satisfied' };
}
export const INDEPENDENT_REVIEW_CONDITION = 'independentReview';
/**
 * Every delivered work package must carry a Reviewer acknowledgement before the Stage can be left.
 *
 * Major declares three semantic reviews and ships `worker` / `integrator` / `reviewer` sub-Agents,
 * but nothing ever *required* a Reviewer: `xforge-verify` says to use one "for high-risk or
 * cross-system results", which is guidance, and the control plane accepted `succeeded` on its own.
 * A live Major run — high risk, security, privacy and public API all true — completed without a
 * single Reviewer acknowledgement, with one executor reviewing the design, the implementation and
 * its own check report. It caught its own mistakes, which is exactly the problem: that outcome
 * rested on the executor's diligence rather than on anything the Flow guaranteed.
 *
 * What this enforces is presence and attribution, not independence. A receipt names an actor, and
 * one session can name any actor it likes, so refusing on "the reviewer equals the integrator"
 * would be enforcing a property the CLI cannot observe. Both names are reported in State instead,
 * where the approver signing the Change can see them.
 */
async function independentReviewCondition(
  project: ProjectContext,
  changeId: string,
  workPackages: WorkPackageResolution,
  expected: string,
  contentRevision: string,
  reviewDiagnostics: Diagnostic[],
): Promise<{ satisfied: boolean; reason: string }> {
  if (expected !== 'complete') return { satisfied: false, reason: `unsupported-expected-${expected}` };
  /* A plan that is present but unreadable is not the plan-less shape, and answering as though it
     were would send the Change to `xforge review acknowledge` — which refuses while a plan file
     exists — instead of to the parse error. Neither branch below can decide anything until the
     file is readable, so the condition says so in its own reason. */
  if (workPackages.status === 'unusable') return { satisfied: false, reason: 'plan-unusable' };
  const packages = workPackages.state?.packages ?? [];
  /*
   * A Change with no work packages used to satisfy this outright, on the reasoning that its
   * semantic review was the Check Stage's. That reasoning does not hold: Check runs *before*
   * implementation, so what it reviews is a design, and the delivered work went unreviewed by
   * anyone. This condition exists to stop exactly one thing — a high-risk Change designed,
   * implemented, reviewed and signed off by a single executor — and the plan-less shape, which
   * `xforge-apply` expressly permits, was the one shape where it asked for nothing at all. A live
   * Major run archived through it having recorded no reviewer acknowledgement of any kind.
   *
   * So that shape now carries its own requirement rather than an exemption: a Change-level review
   * acknowledgement, bound to the content it reviewed.
   */
  if (packages.length === 0) {
    const acknowledgements = await readReviewAcknowledgements(project, changeId);
    /* Rejected receipts are reported, not counted: a file that fails its digest or schema is not
       evidence of a review, and the condition stays unsatisfied so the Change is not closed on it. */
    reviewDiagnostics.push(...acknowledgements.diagnostics);
    if (acknowledgements.receipts.length === 0) return { satisfied: false, reason: 'review-missing' };
    if (!reviewCovers(acknowledgements.receipts, contentRevision)) return { satisfied: false, reason: 'review-stale' };
    return { satisfied: true, reason: 'satisfied-change-level' };
  }
  const unreviewed = packages
    .filter((item) => ['succeeded', 'integrated', 'reviewed'].includes(item.status))
    .filter((item) => !item.acknowledgements?.reviewedBy)
    .map((item) => item.id);
  if (unreviewed.length > 0) return { satisfied: false, reason: `unreviewed-${unreviewed.join('+')}` };
  return { satisfied: true, reason: 'satisfied' };
}
/**
 * One exit condition, routed to whatever decides it.
 *
 * Shared by `resolveControlPlane`'s per-transition loop and by `terminalGovernanceBlocks`, and that
 * sharing is the point. Archive used to re-decide exactly one condition by name —
 * `verificationReceipt` — with a comment explaining why a receipt is Evidence that must be
 * re-decided rather than trusted. Every word of that reasoning applies to `independentReview`,
 * which is also Evidence, is also bound to the content it covers, and was not re-decided at all.
 * Nor would any condition a project adds in its own Flow have been: the archive path named one key
 * and ignored the rest, so an extension declared a door archive never looked at.
 *
 * The gap was reachable rather than theoretical. `contentRevision` digests `change.yaml`, the Flow
 * file and the Artifacts (`core/revision.ts`), and `evidence/review/` is none of those — so
 * removing a review transcript after the closing transition moved nothing, left the ready receipt
 * fresh, and archived a Change whose `independentReview` evidence no longer existed.
 */
export async function evaluateStageCondition(
  project: ProjectContext,
  changeId: string,
  key: string,
  expected: string,
  context: {
    state: ChangeState;
    /* Passed as the resolution rather than read off `state.workPackages`, which cannot say whether
       a null means "no plan" or "nobody loaded one". Judging the second as the first is what let
       the archive path refuse every Change that had a plan. */
    workPackages: WorkPackageResolution;
    contentRevision: string;
    gates: readonly GateEvidence[];
    identities: KnownIdentities;
    diagnostics: Diagnostic[];
    /* Null when this Stage's inputs have never been re-opened; only the ledger reader consults it,
       because the other two evaluators carry a revision binding of their own. */
    reworkCutoff: number | null;
  },
): Promise<{ satisfied: boolean; reason: string }> {
  if (key === VERIFICATION_RECEIPT_CONDITION) {
    return evaluateVerificationReceiptCondition(project, changeId, expected, context.contentRevision, context.gates, context.diagnostics);
  }
  if (key === INDEPENDENT_REVIEW_CONDITION) {
    return independentReviewCondition(project, changeId, context.workPackages, expected, context.contentRevision, context.diagnostics);
  }
  return evaluateExitCondition(project, changeId, key, expected, context.identities, context.reworkCutoff, context.diagnostics);
}
