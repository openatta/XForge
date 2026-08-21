import { readFile, readdir } from 'node:fs/promises';
import type { Diagnostic, ProjectContext } from '../types.js';
import { diagnostic } from './errors.js';
import { sha256, stableStringify } from './hash.js';
import { safeResolve } from './path-safety.js';
import { validateSchema } from './validator.js';

/**
 * A Change-level record that somebody reviewed the delivered work, for Changes that delivered
 * without a work-package plan.
 *
 * `independentReview` exists to stop a high-risk Change being "designed, implemented, reviewed and
 * signed off by a single executor" (see `major.yaml`). It was satisfied by per-package reviewer
 * acknowledgements — and a Change with no packages therefore satisfied it with nothing at all,
 * which is precisely the shape it was written to catch. `xforge-apply` explicitly permits that
 * shape, so the answer cannot be to forbid it; it has to be to give the condition something to
 * require. This is that something.
 *
 * What it deliberately does not claim: that the reviewer is independent. The actor is derived the
 * same way the work-package acknowledgement derives it — from the environment, recorded as an
 * agent — because one session can name any actor it likes, and a field that invites a name invites
 * a fabricated one. The Flow's own note says the same: independence is *reported* in State, never
 * asserted by the receipt. What this does establish is that a review happened, that it produced a
 * file somebody can read, and that both are bound to the content that was reviewed.
 */
export const REVIEW_ACK_DIRECTORY = 'evidence/agents/review';

export interface ReviewAckReceipt {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'ReviewAckReceipt';
  receiptId: string;
  change: string;
  /** The content revision this review was given for; an edit after it invalidates the receipt. */
  contentRevision: string;
  evidence: string;
  evidenceDigest?: string;
  actor: { id: string; provider: string; role: string; type: 'human' | 'agent' | 'system' };
  acknowledgedAt: string;
  digest: string;
}

/**
 * Every Change-level review receipt that survives validation, newest first, with what was rejected.
 *
 * Held to the same bar as the per-package acknowledgement receipts in `core/work-packages.ts`,
 * and for the same reason: a receipt is only worth what its checks are worth. Parse failure, a
 * digest that does not recompute, or a subject naming another Change each drop the receipt and
 * report it — a receipt that fails any of them is not evidence of a review, and counting it would
 * let a hand-written file satisfy the one condition that exists to require an actual reviewer.
 *
 * Rejections are warnings rather than errors, matching the work-package reader: a malformed
 * acknowledgement is skipped, never fatal to every other command on the Change. It still blocks,
 * because skipping it leaves the condition unsatisfied.
 */
export async function readReviewAcknowledgements(
  project: ProjectContext,
  changeId: string,
): Promise<{ receipts: ReviewAckReceipt[]; diagnostics: Diagnostic[] }> {
  const relative = `${project.changesPath}/${changeId}/${REVIEW_ACK_DIRECTORY}/ack`;
  const diagnostics: Diagnostic[] = [];
  let directory: string;
  try { directory = await safeResolve(project.root, relative); }
  catch { return { receipts: [], diagnostics }; }
  let names: string[];
  try { names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(); }
  catch { return { receipts: [], diagnostics }; }

  const receipts: ReviewAckReceipt[] = [];
  for (const name of names) {
    const projectPath = `${relative}/${name}`;
    let receipt: ReviewAckReceipt;
    try {
      receipt = JSON.parse(await readFile(await safeResolve(project.root, projectPath), 'utf8')) as ReviewAckReceipt;
    } catch (error) {
      diagnostics.push(diagnostic('XFORGE_REVIEW_ACK_RECEIPT_INVALID', `Review acknowledgement receipt is not valid JSON: ${(error as Error).message}`, projectPath, 'warning'));
      continue;
    }
    const schemaDiagnostics = await validateSchema('review-ack-receipt', receipt, projectPath);
    const schemaFailed = schemaDiagnostics.some((item) => item.severity === 'error');
    diagnostics.push(...schemaDiagnostics.map((item) => ({ ...item, severity: 'warning' as const })));
    if (schemaFailed) continue;
    const { digest, ...unsigned } = receipt;
    if (digest !== sha256(stableStringify(unsigned))) {
      diagnostics.push(diagnostic('XFORGE_REVIEW_ACK_RECEIPT_DIGEST_INVALID', 'Review acknowledgement receipt digest is invalid.', projectPath, 'warning'));
      continue;
    }
    if (receipt.change !== changeId) {
      diagnostics.push(diagnostic('XFORGE_REVIEW_ACK_RECEIPT_SUBJECT_MISMATCH', `Review acknowledgement receipt names Change ${receipt.change}, not ${changeId}.`, projectPath, 'warning'));
      continue;
    }
    receipts.push(receipt);
  }
  receipts.sort((left, right) => right.acknowledgedAt.localeCompare(left.acknowledgedAt));
  return { receipts, diagnostics };
}

/**
 * Whether a Change-level review covers `contentRevision`.
 *
 * Bound to content rather than to a commit, for the same reason every other receipt in this system
 * is: a review of an Artifact that has since been edited is a review of a different Change.
 */
export function reviewCovers(receipts: readonly ReviewAckReceipt[], contentRevision: string): boolean {
  return receipts.some((receipt) => receipt.contentRevision === contentRevision);
}
