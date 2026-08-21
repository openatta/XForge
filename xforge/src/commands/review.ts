import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import type { Diagnostic, FileChange, ProjectContext } from '../types.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { sha256, stableStringify } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { normalizeRelative, safeResolve } from '../core/path-safety.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { resolveWorkPackages } from '../core/work-packages.js';
import { acknowledgementAttestationDigest, recordAudit } from '../core/audit.js';
import { validateSchema } from '../core/validator.js';
import { REVIEW_ACK_DIRECTORY, reviewEvidenceDigest, type ReviewAckReceipt } from '../core/review-acknowledgement.js';

/**
 * Records that somebody reviewed this Change's delivered work, for Changes delivered without a
 * work-package plan.
 *
 * The per-package `work-package acknowledge --as reviewer` is the same act at package granularity.
 * This exists because the plan-less delivery shape — which `xforge-apply` permits for small work —
 * left `independentReview` with nothing to require, so a Major Change could be implemented and
 * signed off by one executor with no review recorded anywhere. It is refused when a plan exists:
 * two ways to satisfy one condition would let a Change with unreviewed packages buy its way past
 * them with a single Change-level note.
 *
 * The actor is read from the environment and recorded as an agent, exactly as the per-package
 * acknowledgement does. There is deliberately no `--by`: a field inviting a reviewer's name invites
 * a fabricated one, and the Flow's own note is explicit that independence is reported in State
 * rather than asserted by the receipt. What the receipt establishes is narrower and checkable — a
 * review happened, it left a file, and both are bound to the content that was reviewed.
 */
export async function executeReviewAcknowledge(project: ProjectContext, options: {
  change: string;
  evidence: string;
  dryRun: boolean;
}): Promise<{ data: Record<string, unknown>; diagnostics: Diagnostic[]; changes: FileChange[] }> {
  assertManaged(project, 'review acknowledge');
  const evidence = normalizeRelative(options.evidence, 'review acknowledgement evidence');
  const evidenceRoot = `${project.changesPath}/${options.change}/${REVIEW_ACK_DIRECTORY}/`;
  if (!evidence.startsWith(evidenceRoot)) {
    throw new XForgeError(diagnostic(
      'XFORGE_REVIEW_ACK_EVIDENCE_SCOPE',
      `Review evidence must be stored below ${evidenceRoot}, so it archives with the Change it describes.`,
      evidence,
    ));
  }
  const evidenceAbsolute = await safeResolve(project.root, evidence);
  let evidenceStat;
  try { evidenceStat = await stat(evidenceAbsolute); }
  catch { throw new XForgeError(diagnostic('XFORGE_REVIEW_ACK_EVIDENCE_MISSING', 'Review evidence does not exist. Write the review before recording it.', evidence)); }
  if (!evidenceStat.isFile()) throw new XForgeError(diagnostic('XFORGE_REVIEW_ACK_EVIDENCE_MISSING', 'Review evidence must be a regular file.', evidence));

  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) {
    throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', 'review acknowledge requires a Protocol 2 governed Flow.'));
  }
  const resources = await loadSelectedResources(project);
  const workPackages = await resolveWorkPackages(project, options.change, resolved.config, resources);
  if (workPackages.state && workPackages.state.packages.length > 0) {
    throw new XForgeError(diagnostic(
      'XFORGE_REVIEW_ACK_PLAN_PRESENT',
      `This Change has a work-package plan, so its reviews are recorded per package: run \`xforge work-package acknowledge --change ${options.change} --package <id> --as reviewer --evidence <path>\`. A Change-level review would otherwise stand in for packages nobody reviewed.`,
      `${project.changesPath}/${options.change}/work-packages.yaml`,
    ));
  }
  resolved.state.workPackages = workPackages.state;
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config);
  const diagnostics = [...resolved.diagnostics, ...resources.diagnostics, ...workPackages.diagnostics, ...control.diagnostics];
  if (diagnostics.some((item) => item.severity === 'error')) throw new XForgeError(diagnostics, { root: project.root });

  const { revision, currentStage } = control.governance;
  const unsigned = {
    apiVersion: 'xforge.dev/v1alpha2' as const,
    kind: 'ReviewAckReceipt' as const,
    receiptId: randomUUID(),
    change: options.change,
    contentRevision: revision.contentRevision,
    evidence,
    evidenceDigest: reviewEvidenceDigest(await readFile(evidenceAbsolute)),
    actor: { id: process.env.USER ?? 'unknown', provider: 'local-os', role: 'reviewer', type: 'agent' as const },
    acknowledgedAt: new Date().toISOString(),
  };
  const receipt: ReviewAckReceipt = { ...unsigned, digest: sha256(stableStringify(unsigned)) };
  const schemaDiagnostics = await validateSchema('review-ack-receipt', receipt, evidence);
  if (schemaDiagnostics.some((item) => item.severity === 'error')) throw new XForgeError(schemaDiagnostics, { root: project.root });

  /*
   * Keyed on the receiptId, not the content revision. The evidence file lives outside the Artifact
   * outputs, so it is not an input to `contentRevision` — a reviewer correcting their transcript
   * and acknowledging again produces the same revision, and a revision-keyed name would overwrite
   * the earlier receipt while still reporting `action: 'create'`. Two reviewers at one revision
   * collapsed the same way. The per-package equivalent avoids this by keying on a unique execution.
   */
  const target = `${project.changesPath}/${options.change}/${REVIEW_ACK_DIRECTORY}/ack/${receipt.receiptId}.json`;
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  const changes: FileChange[] = [{ action: 'create', path: target, digest: sha256(content), source: 'review:acknowledge' }];
  if (!options.dryRun) {
    /* Resolved before the write, so the unwind below cannot fail on path resolution and replace the
       audit error with a less useful one while leaving the orphan it exists to remove. */
    const absoluteTarget = await safeResolve(project.root, target);
    await atomicWrite(project.root, target, content);
    /*
     * The receipt is worthless without the event, so a failed audit write takes the receipt with it.
     * `readReviewAcknowledgements` counts nothing the chain does not attest, and the filename is a
     * fresh uuid, so an orphan left here is not replaced by a retry — it accumulates, and every
     * later command reports it as a forgery for a review that genuinely happened, with no command
     * that clears it. `work-package acknowledge` unwinds for exactly this reason.
     */
    try {
      await recordAudit(project, {
        eventType: 'review.acknowledged', change: options.change, flow: resolved.flow.metadata.name,
        stage: currentStage, revision, outcome: 'succeeded',
        inputDigest: acknowledgementAttestationDigest(receipt.digest), input: null,
        output: { contentRevision: receipt.contentRevision, evidence, actor: receipt.actor.id },
      });
    } catch (error) {
      await rm(absoluteTarget, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return {
    data: { change: options.change, contentRevision: receipt.contentRevision, evidence, receipt: target, dryRun: options.dryRun },
    diagnostics,
    changes,
  };
}
