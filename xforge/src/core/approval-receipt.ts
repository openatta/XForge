import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ApprovalPolicy, ApprovalReceipt, Diagnostic, ProjectContext } from '../types.js';
import { diagnostic } from './errors.js';
import { sha256, stableStringify } from './hash.js';

export function approvalReceiptDigest(receipt: ApprovalReceipt): string {
  const { digest: _digest, ...unsigned } = receipt;
  return sha256(stableStringify(unsigned));
}

export function approvalSignedPayload(receipt: ApprovalReceipt): string {
  const { signature: _signature, digest: _digest, ...payload } = receipt;
  return stableStringify(payload);
}

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
    if (receipt.signature) diagnostics.push(diagnostic('XFORGE_APPROVAL_SIGNATURE_UNEXPECTED', 'Local approval receipts must not carry an external-provider signature.'));
    return diagnostics;
  }
  const provider = project.manifest.approvals?.providers.find((item) => item.id === receipt.approver.provider);
  if (!provider || policy && !policy.providers.includes(provider.id)) {
    diagnostics.push(diagnostic('XFORGE_APPROVAL_PROVIDER_FORBIDDEN', `Approval provider is not authorized: ${receipt.approver.provider}.`));
    return diagnostics;
  }
  if (!provider.roles.includes(receipt.approver.role) || policy && !policy.roles.includes(receipt.approver.role)) {
    diagnostics.push(diagnostic('XFORGE_APPROVAL_ROLE_FORBIDDEN', `Approver role is not authorized: ${receipt.approver.role}.`));
  }
  if (provider.type === 'mcp') {
    if (receipt.signature) diagnostics.push(diagnostic('XFORGE_APPROVAL_SIGNATURE_UNEXPECTED', 'MCP-issued approval receipts must not carry a signature.'));
    return diagnostics;
  }
  const secret = process.env[provider.secretEnv];
  if (!secret) {
    diagnostics.push(diagnostic('XFORGE_APPROVAL_PROVIDER_UNAVAILABLE', `Approval provider secret environment is unavailable: ${provider.secretEnv}.`));
    return diagnostics;
  }
  if (!receipt.signature || receipt.signature.algorithm !== 'hmac-sha256') {
    diagnostics.push(diagnostic('XFORGE_APPROVAL_SIGNATURE_REQUIRED', 'External approval requires an HMAC signature.'));
    return diagnostics;
  }
  const expected = createHmac('sha256', secret).update(approvalSignedPayload(receipt)).digest('hex');
  const actual = receipt.signature.value;
  if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    diagnostics.push(diagnostic('XFORGE_APPROVAL_SIGNATURE_INVALID', 'External approval signature is invalid.'));
  }
  return diagnostics;
}
