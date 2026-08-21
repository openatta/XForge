import { readFile, readdir } from 'node:fs/promises';
import type { ProjectContext } from '../types.js';
import { safeResolve } from './path-safety.js';

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

/** Every structurally readable Change-level review receipt, newest first. */
export async function readReviewAcknowledgements(
  project: ProjectContext,
  changeId: string,
): Promise<ReviewAckReceipt[]> {
  const relative = `${project.changesPath}/${changeId}/${REVIEW_ACK_DIRECTORY}/ack`;
  let directory: string;
  try { directory = await safeResolve(project.root, relative); }
  catch { return []; }
  let names: string[];
  try { names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(); }
  catch { return []; }
  const receipts: ReviewAckReceipt[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(await safeResolve(project.root, `${relative}/${name}`), 'utf8')) as ReviewAckReceipt;
      if (parsed?.kind === 'ReviewAckReceipt') receipts.push(parsed);
    } catch { /* An unreadable receipt is reported by `check`'s schema pass, not counted here. */ }
  }
  return receipts.sort((left, right) => right.acknowledgedAt.localeCompare(left.acknowledgedAt));
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
