import { randomUUID } from 'node:crypto';
import type { Diagnostic, FileChange, ProjectContext, TransitionReceipt } from '../types.js';
import { recordAudit, verifyAudit } from '../core/audit.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { sha256, stableStringify } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveWorkPackages } from '../core/work-packages.js';

export async function executeTransition(project: ProjectContext, options: { change: string; to: string; dryRun: boolean }): Promise<{
  data: { change: string; from: string; to: string; ready: boolean; receipt: TransitionReceipt | null; dryRun: boolean };
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'transition');
  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', 'transition requires a Protocol 2 governed Flow.'));
  const resources = await loadSelectedResources(project);
  const workPackages = await resolveWorkPackages(project, options.change, resolved.config, resources);
  resolved.state.workPackages = workPackages.state;
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config);
  const requirement = control.transitionRequirements.get(options.to);
  if (!requirement) throw new XForgeError(diagnostic('XFORGE_TRANSITION_INVALID', `Transition ${control.governance.currentStage} -> ${options.to} is not allowed by the Flow.`));
  const diagnostics = [...resources.diagnostics, ...workPackages.diagnostics, ...control.diagnostics];
  for (const block of requirement.blockedBy) diagnostics.push(diagnostic('XFORGE_TRANSITION_BLOCKED', `Transition is blocked by ${block}.`, `${project.changesPath}/${options.change}`));
  const ready = !diagnostics.some((item) => item.severity === 'error');
  if (options.dryRun || !ready) return { data: { change: options.change, from: control.governance.currentStage, to: options.to, ready, receipt: null, dryRun: options.dryRun }, diagnostics, changes: [] };

  await recordAudit(project, { eventType: 'stage.entering', change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage, revision: control.governance.revision, decision: options.to, outcome: 'succeeded' });
  const audit = await verifyAudit(project);
  const sequence = control.governance.transitions.length + 1;
  const unsigned = {
    apiVersion: 'xforge.dev/v1alpha2' as const, kind: 'TransitionReceipt' as const, receiptId: randomUUID(), sequence, change: options.change,
    flow: resolved.flow.metadata.name, from: control.governance.currentStage, to: options.to, contentRevision: control.governance.revision.contentRevision,
    stateRevisionBefore: control.governance.revision.stateRevision, policySnapshotDigest: control.governance.revision.policySnapshotDigest,
    gitHead: control.governance.revision.gitHead, previousReceiptDigest: control.governance.transitionHead, transitionedAt: new Date().toISOString(),
    actor: { id: process.env.XFORGE_ACTOR_ID ?? process.env.USER ?? 'unknown', provider: process.env.XFORGE_ACTOR_PROVIDER ?? 'local-os', type: process.env.XFORGE_ACTOR_TYPE === 'agent' ? 'agent' as const : 'human' as const },
    approvals: requirement.approvals.map((item) => item.digest).sort(), gates: requirement.gates.map((item) => item.digest).sort(), auditHead: audit.head,
  };
  const receipt: TransitionReceipt = { ...unsigned, digest: sha256(stableStringify(unsigned)) };
  const target = `${project.changesPath}/${options.change}/evidence/receipts/transitions/${String(sequence).padStart(4, '0')}-${receipt.receiptId}.json`;
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  await atomicWrite(project.root, target, content);
  const nextResolved = await resolveChangeState(project, options.change);
  const nextControl = await resolveControlPlane(project, options.change, nextResolved.flow as typeof resolved.flow, nextResolved.state, resources, nextResolved.config);
  await recordAudit(project, { eventType: 'stage.entered', change: options.change, flow: resolved.flow.metadata.name, stage: options.to, revision: nextControl.governance.revision, decision: options.to, outcome: 'succeeded', input: { transitionReceipt: receipt.digest } });
  const change: FileChange = { action: 'create', path: target, digest: sha256(content), source: `transition:${receipt.from}:${receipt.to}` };
  return { data: { change: options.change, from: receipt.from, to: receipt.to, ready: true, receipt, dryRun: false }, diagnostics, changes: [change] };
}
