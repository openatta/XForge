import type { ApprovalPolicy, ApprovalReceipt, Diagnostic, ProjectContext } from '../types.js';
import { diagnostic } from './errors.js';
import { sha256, stableStringify } from './hash.js';

export function approvalReceiptDigest(receipt: ApprovalReceipt): string {
  const { digest: _digest, ...unsigned } = receipt;
  return sha256(stableStringify(unsigned));
}

/**
 * Structural checks only: digest self-consistency, and that the receipt's provider/policy/role are
 * ones the policy actually authorizes. This does NOT prove the receipt is authentic — a hand-placed
 * JSON file can satisfy all of it, since neither `local` nor `mcp` receipts carry a signature.
 * Authenticity is established separately, by requiring the project's own tamper-evident audit hash
 * chain to have independently recorded the `approval.decided` event that produced this receipt (see
 * `approvalVerifiedInChain` in `core/audit.ts`, called from `loadApprovalReceipts` in
 * `core/control-plane.ts`). A receipt that passes this function but has no matching chain record is
 * still rejected by the caller.
 */
export function verifyApprovalReceipt(
  project: ProjectContext,
  receipt: ApprovalReceipt,
  policy?: ApprovalPolicy,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (receipt.digest !== approvalReceiptDigest(receipt)) {
    diagnostics.push(diagnostic('XFORGE_APPROVAL_RECEIPT_DIGEST_INVALID', 'Approval receipt digest is invalid.'));
  }
  if (receipt.approver.provider === 'local') {
    if (policy && !policy.providers.includes('local')) {
      diagnostics.push(diagnostic('XFORGE_APPROVAL_PROVIDER_FORBIDDEN', 'Policy does not allow local approvals.'));
      return diagnostics;
    }
    if (policy && !policy.roles.includes(receipt.approver.role)) {
      diagnostics.push(diagnostic('XFORGE_APPROVAL_ROLE_FORBIDDEN', `Approver role is not authorized: ${receipt.approver.role}.`));
    }
    return diagnostics;
  }
  const provider = project.manifest.approvals?.providers.find((item) => item.id === receipt.approver.provider);
  if (!provider || (policy && !policy.providers.includes(provider.id))) {
    diagnostics.push(diagnostic('XFORGE_APPROVAL_PROVIDER_FORBIDDEN', `Approval provider is not authorized: ${receipt.approver.provider}.`));
    return diagnostics;
  }
  if (!provider.roles.includes(receipt.approver.role) || (policy && !policy.roles.includes(receipt.approver.role))) {
    diagnostics.push(diagnostic('XFORGE_APPROVAL_ROLE_FORBIDDEN', `Approver role is not authorized: ${receipt.approver.role}.`));
  }
  return diagnostics;
}
