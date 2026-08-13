import { randomUUID } from 'node:crypto';
import type { Diagnostic, FileChange, ProjectContext, TransitionReceipt } from '../types.js';
import { localChainPrunedCount, readChangeAuditIndex, readChangeLogEvents, recordAudit, verifyAudit } from '../core/audit.js';
import { blockRemedy, resolveControlPlane } from '../core/control-plane.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite, rollbackWrittenFile } from '../core/files.js';
import { flowEligibilityDiagnostics } from '../core/checker.js';
import { isStageFlow, loadFlows, resolveChangeState } from '../core/flow-resolver.js';
import { sha256, stableStringify } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveWorkPackages } from '../core/work-packages.js';

/**
 * Receipts on disk whose `stage.entered` event appears in neither the local chain nor the
 * committed index: a previous run crashed between the two writes, and re-running from here would
 * silently build on a receipt the chain never attested.
 *
 * The local chain gates the scan: a fresh clone has no local events, and its committed index may
 * legitimately be truncated past the 1000-event summary limit — flagging old receipts there would
 * turn a retention boundary into a false accusation.
 *
 * The same holds when the local chain is retention-pruned AND the committed index is unusable
 * (missing, digest-invalid, or itself truncated): the attestation digests then exist nowhere this
 * machine can read, and the scan cannot distinguish a crash remnant from a pruned-but-legitimate
 * receipt. In that combination the scan is skipped rather than accusing a retention boundary.
 */
async function orphanTransitionReceipts(project: ProjectContext, changeId: string, receipts: TransitionReceipt[]): Promise<string[]> {
  if (receipts.length === 0) return [];
  const local = await readChangeLogEvents(project, changeId);
  if (local.length === 0) return [];
  const committed = await readChangeAuditIndex(project, changeId);
  const indexUsable = Boolean(committed?.digestValid && !committed.document.eventsTruncated);
  if (!indexUsable && await localChainPrunedCount(project, changeId) > 0) return [];
  const localDigests = new Set(local.filter((event) => event.eventType === 'stage.entered').map((event) => event.inputDigest));
  const committedDigests = new Set((committed?.digestValid ? committed.document.events : [])
    .filter((event) => event.eventType === 'stage.entered')
    .map((event) => event.inputDigest));
  const expected = (digest: string): string => sha256(stableStringify({ transitionReceipt: digest }));
  return receipts
    .filter((receipt) => !localDigests.has(expected(receipt.digest)) && !committedDigests.has(expected(receipt.digest)))
    .map((receipt) => receipt.receiptId);
}

export async function executeTransition(project: ProjectContext, options: { change: string; to: string; dryRun: boolean }): Promise<{
  data: { change: string; from: string; to: string; ready: boolean; receipt: TransitionReceipt | null; dryRun: boolean };
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'transition');
  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', 'transition requires a Protocol 2 governed Flow.'));
  // A Change whose classification outgrew its Flow must fail here, at the first Stage
  // transition, rather than after all implementation work is done at archive time.
  const flowsResult = await loadFlows(project);
  const eligibility = flowEligibilityDiagnostics(
    resolved.flow,
    resolved.config,
    flowsResult.flows.values(),
    `${project.changesPath}/${options.change}/change.yaml`,
  );
  const resources = await loadSelectedResources(project);
  const workPackages = await resolveWorkPackages(project, options.change, resolved.config, resources);
  resolved.state.workPackages = workPackages.state;
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config);
  const requirement = control.transitionRequirements.get(options.to);
  if (!requirement) {
    throw new XForgeError([
      ...eligibility,
      diagnostic('XFORGE_TRANSITION_INVALID', `Transition ${control.governance.currentStage} -> ${options.to} is not allowed by the Flow.`),
    ]);
  }
  const diagnostics = [...eligibility, ...resources.diagnostics, ...workPackages.diagnostics, ...control.diagnostics];
  for (const block of requirement.blockedBy) diagnostics.push(diagnostic('XFORGE_TRANSITION_BLOCKED', `Transition is blocked by ${block}.`, `${project.changesPath}/${options.change}`));
  const remedy = blockRemedy(requirement.blockedBy, options.change);
  if (remedy) diagnostics.push(diagnostic('XFORGE_GATE_EVIDENCE_STALE_REMEDY', remedy, `${project.changesPath}/${options.change}`, 'info'));
  const ready = !diagnostics.some((item) => item.severity === 'error');
  if (options.dryRun || !ready) return { data: { change: options.change, from: control.governance.currentStage, to: options.to, ready, receipt: null, dryRun: options.dryRun }, diagnostics, changes: [] };

  /*
   * The receipt attests a verified chain, so a broken chain must stop the transition before any
   * event claims the Stage was entered. Checked first: a refused transition leaves no trace.
   * Cross-shard damage (another Change's corrupted chain) stops this transition too, deliberately —
   * a receipt bound to a head over an invalid chain would launder the breakage.
   */
  const audit = await verifyAudit(project);
  if (!audit.valid) {
    throw new XForgeError(
      diagnostic('XFORGE_TRANSITION_AUDIT_CHAIN_INVALID', `The audit chain does not verify (${audit.diagnostics.length} failing event(s)); refusing to record a Transition against a broken chain.`),
      {
        nextActions: [{
          action: 'restore-audit-chain', type: 'governance', actor: 'human',
          reason: 'Inspect the failing events with `xforge audit verify`. The chain is append-only and cannot be repaired in place: restore xforge/.audit/** from a trusted copy, or continue from a fresh clone — the committed audit index under the Change\'s evidence preserves the facts archive needs.',
          command: ['xforge', 'audit', 'verify'],
        }],
      },
    );
  }
  const orphans = await orphanTransitionReceipts(project, options.change, control.governance.transitions);
  if (orphans.length > 0) {
    throw new XForgeError(
      diagnostic('XFORGE_TRANSITION_ORPHAN_RECEIPT', `A Transition receipt exists that no stage.entered audit event attests (a previous run crashed between writing the receipt and recording the event): ${orphans.join(', ')}.`),
      {
        nextActions: [{
          action: 'remove-orphan-receipt', type: 'governance', actor: 'human',
          reason: `Delete the orphan receipt file(s) under ${project.changesPath}/${options.change}/evidence/receipts/transitions/ and re-run the transition; the Stage will re-resolve from the receipts that remain.`,
        }],
      },
    );
  }

  await recordAudit(project, { eventType: 'stage.entering', change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage, revision: control.governance.revision, decision: options.to, outcome: 'succeeded' });
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
  try {
    const nextResolved = await resolveChangeState(project, options.change);
    const nextControl = await resolveControlPlane(project, options.change, nextResolved.flow as typeof resolved.flow, nextResolved.state, resources, nextResolved.config);
    await recordAudit(project, { eventType: 'stage.entered', change: options.change, flow: resolved.flow.metadata.name, stage: options.to, revision: nextControl.governance.revision, decision: options.to, outcome: 'succeeded', input: { transitionReceipt: receipt.digest } });
  } catch (error) {
    /* The Stage resolves from receipts on disk; a receipt the chain never attested must not stay. */
    await rollbackWrittenFile(project.root, target);
    throw error;
  }
  const change: FileChange = { action: 'create', path: target, digest: sha256(content), source: `transition:${receipt.from}:${receipt.to}` };
  return { data: { change: options.change, from: receipt.from, to: receipt.to, ready: true, receipt, dryRun: false }, diagnostics, changes: [change] };
}
