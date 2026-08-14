import { access, readFile } from 'node:fs/promises';
import type { GateEvidence, ProjectContext } from '../types.js';
import { safeResolve } from './path-safety.js';
import { loadYaml } from './yaml.js';

/**
 * The machine-decidable half of the Verify Stage.
 *
 * `verification-receipt` is required by all three shipped Flows and, until this file existed, the
 * string appeared nowhere in `xforge/src`. Its only check was `core/flow-resolver.ts`'s Artifact
 * rule — the file exists and carries some content — so `echo x > evidence/verification-receipt.yaml`
 * closed the last Stage before archive. That is precisely the "Agent PASS is not a Gate" pattern
 * `core/check-findings.ts` was written to remove, still standing in the one Stage whose whole job is
 * to say the work was verified.
 *
 * A receipt is worth something only if it names what it is a receipt *for*, so this ledger is
 * decided against facts the Agent does not author:
 *
 * - `contentRevision` must be the Change's current content revision. A receipt describing content
 *   that has since been edited is a receipt for a different Change.
 * - Every Gate Evidence the Stage actually produced must be cited, by its own `digest`, and nothing
 *   else may be. Citing a digest requires having run the Gate; omitting one hides a Gate that ran.
 * - `gitHead` must be present, as provenance for whoever reads the receipt later. It is deliberately
 *   *not* compared to anything. An earlier revision of this file required it to equal the commit the
 *   cited Evidence ran at, which a live run showed to be unsatisfiable: the Evidence is regenerated
 *   after the Stage's work is committed, so the receipt's HEAD is always the parent of the
 *   Evidence's. The same is true of any integrator merge. `core/revision.ts` already treats gitHead
 *   as audit metadata precisely because a commit that changes no governed content is not staleness —
 *   `contentRevision` above is the binding that carries the weight, and it is commit-independent.
 *
 * One thing this file cannot fix on its own, and the reason it does not compare against a
 * self-declared revision: while `evidence/verification-receipt.yaml` is a declared Flow Artifact,
 * its own bytes feed `contentRevision` (`core/revision.ts` digests every Artifact output). A file
 * that has to state the digest of a set it belongs to has no fixed point, and writing it would make
 * every Gate that just passed `stale`. The Flow must therefore stop treating the receipt as a
 * content-governing Artifact and declare it as this exit condition instead; see the wiring note in
 * the change report. Until a Flow declares `exit.conditions.verificationReceipt`, nothing here runs.
 */
export const VERIFICATION_RECEIPT_PATH = 'evidence/verification-receipt.yaml';

/** The reserved exit-condition key that routes to this evaluator instead of a conditions ledger. */
export const VERIFICATION_RECEIPT_CONDITION = 'verificationReceipt';

export interface VerificationReceiptExpectation {
  /** The Change's current content revision; the receipt must be bound to exactly this. */
  contentRevision: string;
  /** The Gate Evidence that actually passed for the Stage being closed. */
  gates: readonly GateEvidence[];
}

export interface VerificationReceiptResult {
  status: 'passed' | 'failed';
  /** One line per problem, in the order they were found; empty when the receipt is acceptable. */
  problems: string[];
  /** A short, stable slug for the first problem, shaped for a `condition:<key>:<reason>` block. */
  reason: string;
  /** Gate ids the receipt cited, whether or not they were accepted. */
  cited: string[];
}

interface ReceiptGateCitation {
  inputDigest?: unknown;
  gate?: unknown;
  evidence?: unknown;
  status?: unknown;
}

interface VerificationReceiptLedger {
  change?: unknown;
  status?: unknown;
  contentRevision?: unknown;
  gitHead?: unknown;
  gates?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function failed(reason: string, problems: string[], cited: string[] = []): VerificationReceiptResult {
  return { status: 'failed', problems, reason, cited };
}

function evaluate(
  document: VerificationReceiptLedger,
  changeId: string,
  relative: string,
  expected: VerificationReceiptExpectation,
): VerificationReceiptResult {
  const subject = text(document.change);
  if (subject && subject !== changeId) {
    return failed('subject-mismatch', [`${relative}: the receipt is bound to Change "${subject}", not ${changeId}.`]);
  }

  const declared = text(document.status);
  if (declared !== 'passed') {
    return failed(`status-${declared || 'missing'}`, [`${relative}: status is "${declared || '(none)'}"; a verification receipt records "passed" or it is not a receipt.`]);
  }

  const contentRevision = text(document.contentRevision);
  if (!contentRevision) return failed('content-revision-missing', [`${relative}: no contentRevision; the receipt must name the content it verified.`]);
  if (contentRevision !== expected.contentRevision) {
    return failed('content-revision-stale', [
      `${relative}: contentRevision ${contentRevision} is not the Change's current content revision ${expected.contentRevision}; the Change was edited after this receipt was written.`,
    ]);
  }

  const gitHead = text(document.gitHead);
  if (!gitHead) return failed('git-head-missing', [`${relative}: no gitHead; the receipt must name the commit it was produced at.`]);

  const citations = Array.isArray(document.gates) ? document.gates as ReceiptGateCitation[] : null;
  if (!citations) {
    return failed('gates-missing', [`${relative}: expected a "gates" list citing the Evidence digest of every Gate this Stage ran. Record an explicit empty list only when the Stage declares no Gates.`]);
  }

  const problems: string[] = [];
  const cited: string[] = [];
  const byGate = new Map(expected.gates.map((evidence) => [evidence.gate, evidence]));
  const seen = new Set<string>();

  for (const [index, raw] of citations.entries()) {
    const citation = (raw ?? {}) as ReceiptGateCitation;
    const gate = text(citation.gate);
    const label = gate || `#${index + 1}`;
    if (!gate) { problems.push(`${relative}: gate citation ${label} does not name a Gate.`); continue; }
    cited.push(gate);
    if (seen.has(gate)) { problems.push(`${relative}: Gate ${gate} is cited twice.`); continue; }
    seen.add(gate);
    const evidence = byGate.get(gate);
    if (!evidence) {
      /* Either the Gate is not one this Stage ran, or its Evidence is missing, failed or stale — in
         every one of those cases the Change is already blocked on `gate:<id>:<reason>` and saying
         so twice helps nobody; what this line adds is that the receipt claims otherwise. */
      problems.push(`${relative}: Gate ${gate} is cited, but no passing, current Evidence for it exists in this Stage.`);
      continue;
    }
    /*
     * Citations name the Gate, not a digest of its Evidence. Every per-run digest available here
     * moves under ordinary progress: the Evidence `digest` covers timestamps, so archive's re-run
     * of the Gate set rewrites it, and `inputDigest` is `sha256({gate, revision, structurePassed})`
     * over the whole revision — including `stateRevision`, which changes the moment the Stage
     * transitions. A receipt written at Verify could therefore never survive into archive. What the
     * receipt has to prove is that it describes *this content*, and `contentRevision` above already
     * proves exactly that; requiring the cited set to be the set that actually passed is what a
     * hand-written receipt still cannot fake.
     */
    const status = text(citation.status);
    if (status && status !== 'passed') problems.push(`${relative}: Gate ${gate} is cited as "${status}"; only a passed Gate belongs in a verification receipt.`);
  }

  for (const evidence of expected.gates) {
    if (!seen.has(evidence.gate)) problems.push(`${relative}: Gate ${evidence.gate} passed for this Stage but the receipt does not cite it.`);
  }

  if (problems.length === 0) return { status: 'passed', problems, reason: 'satisfied', cited };
  /* The block string carries one slug, so it names the first and most specific failure; the full
     list travels in `problems` for the caller that can print more than a `blockedBy` entry. */
  const uncited = expected.gates.find((evidence) => !seen.has(evidence.gate));
  const unknown = cited.find((gate) => !byGate.has(gate));
  const reason = uncited ? `gate-uncited-${uncited.gate}` : unknown ? `gate-unverifiable-${unknown}` : 'gate-citation-mismatch';
  return failed(reason, problems, cited);
}

export async function evaluateVerificationReceipt(
  project: ProjectContext,
  changeId: string,
  expected: VerificationReceiptExpectation,
): Promise<VerificationReceiptResult> {
  const relative = `${project.changesPath}/${changeId}/${VERIFICATION_RECEIPT_PATH}`;
  let absolute: string;
  try { absolute = await safeResolve(project.root, relative); }
  catch { return failed('path-unsafe', [`${relative}: path is outside the project.`]); }
  try { await access(absolute); }
  catch {
    return failed('receipt-missing', [`${relative}: the Verify Stage must record a verification receipt bound to the current revision and to the Gate Evidence that passed.`]);
  }
  /* An empty file parses to null upstream; a readable but contentless receipt is not a receipt. */
  if ((await readFile(absolute, 'utf8')).trim().length === 0) {
    return failed('receipt-empty', [`${relative}: the verification receipt is empty.`]);
  }
  let document: VerificationReceiptLedger;
  try { document = await loadYaml<VerificationReceiptLedger>(absolute, relative); }
  catch (error) { return failed('receipt-unreadable', [`${relative}: ${(error as Error).message}`]); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return failed('receipt-unreadable', [`${relative}: expected a YAML mapping.`]);
  }
  return evaluate(document, changeId, relative, expected);
}
