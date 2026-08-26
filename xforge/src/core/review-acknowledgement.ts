import { readFile, readdir } from 'node:fs/promises';
import type { Diagnostic, ProjectContext } from '../types.js';
import { diagnostic } from './errors.js';
import { sha256, stableStringify } from './hash.js';
import { normalizeRelative, safeResolve } from './path-safety.js';
import { validateSchema } from './validator.js';
import { readAcknowledgementAttestations } from './audit.js';

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
/*
 * Deliberately not under `evidence/agents/`: `core/work-packages.ts` globs
 * `evidence/agents/<id>/ack/*.json` for per-package acknowledgements, and a Change-level receipt
 * sitting in that shape would be read back as a malformed work-package ack — permanently, and only
 * once the Change later gained a plan, which is the worst moment to start emitting warnings about
 * a file that is perfectly valid.
 */
export const REVIEW_ACK_DIRECTORY = 'evidence/review';

/**
 * The transcript's digest, over normalized line endings.
 *
 * Hashing raw bytes made the receipt fail on any machine that checked the file out with CRLF — a
 * generated project has no `.gitattributes`, so a Windows clone with `core.autocrlf` reports
 * EVIDENCE_CHANGED for a file nobody touched and blocks archive until somebody re-acknowledges
 * there. The transcript is prose; its line endings are not part of what was reviewed.
 */
export function reviewEvidenceDigest(content: Buffer): string {
  /*
   * Byte-level, not `toString('utf8')`. Decoding first collapsed every invalid sequence to U+FFFD,
   * so two screenshots differing only in undecodable bytes hashed identically — the binding to what
   * was reviewed stopped working for exactly the files it could not read. `acknowledge` accepts any
   * regular file, so that is not a hypothetical shape.
   */
  const out = Buffer.alloc(content.length);
  let length = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0d && content[index + 1] === 0x0a) continue;
    out[length] = content[index]!;
    length += 1;
  }
  return sha256(out.subarray(0, length));
}

export interface ReviewAckReceipt {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'ReviewAckReceipt';
  receiptId: string;
  change: string;
  /** The content revision this review was given for; an edit after it invalidates the receipt. */
  contentRevision: string;
  evidence: string;
  evidenceDigest: string;
  /**
   * What the reviewer says they covered. Optional and never inferred — an absent scope means
   * nobody said, which is exactly what every receipt written before this field existed means.
   *
   * `independentReview` asks whether a review happened, and had nowhere to record how far it
   * reached. A live Major run finished with thirteen package reviews of deliberately different
   * breadth — early rounds full, the last one restricted to verifying ten named fixes — and the
   * receipts recorded them identically. The difference in evidential strength survived only in the
   * transcript prose, which nothing indexes and nothing carries forward.
   */
  scope?: string;
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

  if (names.length === 0) return { receipts: [], diagnostics };

  /* Read once, and only once there is something to attest. This runs on every control-plane
     resolve of every plan-less Change — every `state`, `check`, `brief` and `transition` — and the
     overwhelmingly common case has no receipts at all, where the chain read is pure cost. */
  const attestations = await readAcknowledgementAttestations(project, changeId);
  const evidenceRoot = `${project.changesPath}/${changeId}/${REVIEW_ACK_DIRECTORY}/`;

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
    /*
     * The check that actually separates a receipt from a claim, and the one the digest above cannot
     * make. Every field here — including `digest` — is computable by whoever wrote the file, so a
     * self-covering hash proves only internal consistency: recompute it correctly and a hand-written
     * receipt passes. What it cannot forge is the audit chain, so `review acknowledge` records
     * `sha256({ackReceipt: <digest>})` on a `review.acknowledged` event and this recomputes it. Same
     * mechanism, same escape hatch, as the per-package reader in `core/work-packages.ts`.
     */
    /*
     * The transcript still has to be there, and still has to be the one that was reviewed. Existence
     * was checked when the receipt was written and never again, so a Change that reworked and
     * deleted or rewrote its review notes kept a receipt that still satisfied the condition — while
     * this module's own contract says the receipt proves a review happened and left a file.
     */
    /* Re-applied on read, not trusted from the write path. `attests` has a deliberate escape for a
       Change with no audit data at all (a fresh clone whose chain is gitignored), and under it a
       hand-written receipt citing any file in the repository would otherwise satisfy the condition. */
    /* Normalized before comparing, because the read below normalizes too: comparing the raw string
       let `evidence/review/../../../../../README.md` satisfy `startsWith` and then resolve to
       `README.md`. The write path already normalizes first; the reader has to agree with it, or the
       guard only stops the honest spelling of the thing it exists to stop. */
    let citedPath: string;
    try { citedPath = normalizeRelative(receipt.evidence, 'review acknowledgement evidence'); }
    catch {
      diagnostics.push(diagnostic('XFORGE_REVIEW_ACK_EVIDENCE_SCOPE', `Review acknowledgement cites ${receipt.evidence}, which is not a safe project-relative path.`, projectPath, 'warning'));
      continue;
    }
    if (!citedPath.startsWith(evidenceRoot)) {
      diagnostics.push(diagnostic('XFORGE_REVIEW_ACK_EVIDENCE_SCOPE', `Review acknowledgement cites ${receipt.evidence}, which resolves to ${citedPath} — outside ${evidenceRoot}.`, projectPath, 'warning'));
      continue;
    }
    let evidenceDigest: string | null = null;
    try { evidenceDigest = reviewEvidenceDigest(await readFile(await safeResolve(project.root, citedPath))); }
    catch { evidenceDigest = null; }
    if (evidenceDigest === null) {
      diagnostics.push(diagnostic('XFORGE_REVIEW_ACK_EVIDENCE_MISSING', `Review acknowledgement cites ${receipt.evidence}, which no longer exists.`, projectPath, 'warning'));
      continue;
    }
    if (evidenceDigest !== receipt.evidenceDigest) {
      diagnostics.push(diagnostic('XFORGE_REVIEW_ACK_EVIDENCE_CHANGED', `Review acknowledgement cites ${receipt.evidence}, which has changed since it was reviewed.`, projectPath, 'warning'));
      continue;
    }
    if (!attestations.attests(receipt.digest)) {
      diagnostics.push(diagnostic(
        'XFORGE_REVIEW_ACK_UNATTESTED',
        'Review acknowledgement receipt is not attested by the audit chain and is ignored. A receipt no `review acknowledge` run produced is a claim, not a review.',
        projectPath, 'warning',
      ));
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
