import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ApprovalPolicy, ApprovalReceipt, Diagnostic, FileChange, ProjectContext } from '../types.js';
import { recordAudit } from '../core/audit.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { sha256, stableStringify } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { safeResolve } from '../core/path-safety.js';
import { validateSchema } from '../core/validator.js';
import { approvalReceiptDigest, verifyApprovalReceipt } from '../core/approval-receipt.js';

export interface ApproveOptions {
  change: string;
  transition: string;
  policy?: string;
  actor?: string;
  role?: string;
  reason?: string;
  decision?: 'approve' | 'reject';
  attestation?: 'human';
  receipt?: string;
  interactive: boolean;
  dryRun: boolean;
}

function exitApprovals(flow: any, stageId: string): string[] {
  const exit = flow.stages.find((stage: any) => stage.id === stageId)?.exit;
  return Array.isArray(exit?.approvals) ? exit.approvals : [];
}

function approvalPolicy(flow: any, stageId: string, transition: string, requested?: string): ApprovalPolicy {
  const ids = transition === 'archive' ? flow.terminal.archive.approvals ?? [] : exitApprovals(flow, stageId);
  const selected = requested ?? (ids.length === 1 ? ids[0] : null);
  if (!selected || !ids.includes(selected)) throw new XForgeError(diagnostic('XFORGE_APPROVAL_POLICY_REQUIRED', `Approval policy must be one of: ${ids.join(', ') || '(none)'}.`));
  const policy = flow.governance?.approvalPolicies.find((item: ApprovalPolicy) => item.id === selected);
  if (!policy) throw new XForgeError(diagnostic('XFORGE_APPROVAL_POLICY_MISSING', `Approval policy is not defined: ${selected}.`));
  return policy;
}

function verifyExternalReceipt(project: ProjectContext, receipt: ApprovalReceipt, policy: ApprovalPolicy): void {
  const diagnostics = verifyApprovalReceipt(project, receipt, policy);
  if (diagnostics.length > 0) throw new XForgeError(diagnostics);
}

export async function executeApprove(project: ProjectContext, options: ApproveOptions): Promise<{
  data: { change: string; policy: string; transition: string; receipt: ApprovalReceipt | null; dryRun: boolean };
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'approve');
  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', 'approve requires a Protocol 2 governed Flow.'));
  const resources = await loadSelectedResources(project);
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config);
  const policy = approvalPolicy(resolved.flow, control.governance.currentStage, options.transition, options.policy);
  let receipt: ApprovalReceipt;

  if (!options.dryRun) await recordAudit(project, { eventType: 'approval.requested', change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage, revision: control.governance.revision, decision: policy.id, outcome: 'succeeded' });

  if (options.receipt) {
    const source = await readFile(await safeResolve(project.root, options.receipt), 'utf8');
    receipt = JSON.parse(source) as ApprovalReceipt;
    const schemaDiagnostics = await validateSchema('approval-receipt', receipt, options.receipt);
    if (schemaDiagnostics.some((item) => item.severity === 'error')) throw new XForgeError(schemaDiagnostics);
    verifyExternalReceipt(project, receipt, policy);
  } else {
    if (!options.interactive || options.attestation !== 'human') throw new XForgeError(diagnostic('XFORGE_APPROVAL_INTERACTIVE_REQUIRED', 'Local approval requires an interactive terminal and --attestation human. Use a signed external receipt in non-interactive mode.'));
    if (!policy.providers.includes('local')) throw new XForgeError(diagnostic('XFORGE_APPROVAL_PROVIDER_FORBIDDEN', `Policy ${policy.id} does not allow local approvals.`));
    if (!options.actor || !options.role || !options.reason || !options.decision) throw new XForgeError(diagnostic('XFORGE_APPROVAL_FIELDS_REQUIRED', 'Local approval requires --actor, --role, --reason, and --decision.'));
    if (!policy.roles.includes(options.role)) throw new XForgeError(diagnostic('XFORGE_APPROVAL_ROLE_FORBIDDEN', `Approver role is not authorized: ${options.role}.`));
    const unsigned = {
      apiVersion: 'xforge.dev/v1alpha2' as const, kind: 'ApprovalReceipt' as const, receiptId: randomUUID(), change: options.change,
      flow: resolved.flow.metadata.name, stage: control.governance.currentStage, transition: options.transition, policyId: policy.id,
      stateRevision: control.governance.revision.stateRevision, contentRevision: control.governance.revision.contentRevision,
      policySnapshotDigest: control.governance.revision.policySnapshotDigest, gitBase: control.governance.revision.gitBase, gitHead: control.governance.revision.gitHead,
      governingDigest: sha256(stableStringify({ change: options.change, flow: resolved.flow.metadata.name, policy: policy.id, revision: control.governance.revision })),
      decision: options.decision, approver: { id: options.actor, provider: 'local', role: options.role, type: 'human' as const }, decidedAt: new Date().toISOString(), reason: options.reason,
    };
    receipt = { ...unsigned, digest: approvalReceiptDigest({ ...unsigned, digest: '' }) };
  }

  if (receipt.change !== options.change || receipt.flow !== resolved.flow.metadata.name || receipt.stage !== control.governance.currentStage || receipt.transition !== options.transition || receipt.policyId !== policy.id ||
    receipt.stateRevision !== control.governance.revision.stateRevision || receipt.contentRevision !== control.governance.revision.contentRevision || receipt.policySnapshotDigest !== control.governance.revision.policySnapshotDigest || receipt.gitHead !== control.governance.revision.gitHead) {
    throw new XForgeError(diagnostic('XFORGE_APPROVAL_STALE', 'Approval receipt is not bound to the current Change, Flow, Stage, policy, and revision.'));
  }
  const target = `${project.changesPath}/${options.change}/approvals/${policy.id}/${receipt.receiptId}.json`;
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  const changes: FileChange[] = [{ action: 'create', path: target, digest: sha256(content), source: `approval:${policy.id}` }];
  if (!options.dryRun) {
    await atomicWrite(project.root, target, content);
    await recordAudit(project, { eventType: 'approval.decided', change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage, revision: control.governance.revision, decision: receipt.decision, reason: receipt.reason, outcome: receipt.decision === 'approve' ? 'succeeded' : 'denied', input: { policy: policy.id, receipt: receipt.digest } });
  }
  return { data: { change: options.change, policy: policy.id, transition: options.transition, receipt: options.dryRun ? null : receipt, dryRun: options.dryRun }, diagnostics: [...resources.diagnostics, ...control.diagnostics], changes };
}
