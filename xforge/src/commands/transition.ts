import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Diagnostic, FileChange, NextAction, ProjectContext, TransitionReceipt } from '../types.js';
import { readChangeAuditEvents, readTransitionAttestations, recordAudit, transitionAttestationDigest, verifyAudit } from '../core/audit.js';
import { blockRemedy, resolveControlPlane } from '../core/control-plane.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { flowEligibilityDiagnostics } from '../core/checker.js';
import { isStageFlow, loadFlows, resolveChangeState } from '../core/flow-resolver.js';
import { sha256, stableStringify } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { safeResolve } from '../core/path-safety.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveWorkPackages } from '../core/work-packages.js';

/**
 * Receipts on disk that this working tree wrote and that no `stage.entered` event attests.
 *
 * The write below is receipt-then-record; the `catch` around the record only compensates a *thrown*
 * error. A SIGKILL, a power cut or a container eviction in between leaves the receipt with nothing
 * attesting it, and since `control-plane.ts` derives `currentStage` from `transitions.at(-1)?.to`,
 * that remnant silently advances the Change with no record that it ever happened.
 *
 * Reasoning from an absent event is only sound under both guards below; either one alone accuses
 * honest work:
 *
 * - `readTransitionAttestations` decides whether the readable attestations are the complete set at
 *   all (committed index present, digest-valid, untruncated, unpruned) and whether a given receipt
 *   was even written here. A colleague's receipts, cloned in, are unattested on this machine as a
 *   matter of course.
 * - Suffix contiguity: a crash remnant can only ever be the *last* receipt, or a contiguous run at
 *   the end — the process died mid-transition, so by definition nothing came after it. An
 *   unattested receipt with an attested one after it is evidence that this machine's audit data is
 *   incomplete, not that a transition half-happened, and it gets an informational note rather than
 *   an accusation. This also means the loud warning fires while it matters — before anything is
 *   built on the remnant — and quiets down to a note once a later, attested receipt exists.
 */
async function unattestedReceipts(
  project: ProjectContext,
  changeId: string,
  receipts: TransitionReceipt[],
): Promise<{ orphans: TransitionReceipt[]; incomplete: TransitionReceipt[] }> {
  const empty = { orphans: [], incomplete: [] };
  if (receipts.length === 0) return empty;
  const attestations = await readTransitionAttestations(project, changeId);
  if (!attestations.complete) return empty;
  const ordered = [...receipts].sort((left, right) => left.sequence - right.sequence);
  const attested = ordered.map((receipt) => attestations.attests(receipt.digest));
  if (attested.every(Boolean)) return empty;
  /* One unattested receipt this tree did not write proves the audit data here is partial, which
     disqualifies every absence on the list — including ones that would otherwise look like a crash. */
  if (ordered.some((receipt, index) => !attested[index] && !attestations.writtenHere(receipt.auditHead))) return empty;
  let boundary = ordered.length;
  while (boundary > 0 && !attested[boundary - 1]) boundary -= 1;
  return {
    orphans: ordered.slice(boundary),
    incomplete: ordered.slice(0, boundary).filter((_receipt, index) => !attested[index]),
  };
}

export async function executeTransition(project: ProjectContext, options: { change: string; to: string; dryRun: boolean }): Promise<{
  data: { change: string; from: string; to: string; ready: boolean; receipt: TransitionReceipt | null; dryRun: boolean };
  diagnostics: Diagnostic[];
  changes: FileChange[];
  nextActions: NextAction[];
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

  /*
   * Surfaced as a warning, not a block, and deliberately: the Stage this remnant advanced to is
   * already the Change's current Stage, and there is no `xforge audit repair`. Blocking would leave
   * the only exit the one this scan exists to avoid recommending — deleting governance evidence,
   * which rewinds `currentStage` and breaks the `previousReceiptDigest` chain of every later
   * receipt. A loud, repeated warning that names the receipt and the missing event leaves the
   * evidence intact and the decision with a human.
   */
  const receiptsPath = `${project.changesPath}/${options.change}/evidence/receipts/transitions`;
  const nextActions: NextAction[] = [];
  const unattested = await unattestedReceipts(project, options.change, control.governance.transitions);
  if (unattested.orphans.length > 0) {
    const listed = unattested.orphans.map((receipt) => `${receipt.receiptId} (${receipt.from} -> ${receipt.to})`).join(', ');
    diagnostics.push(diagnostic(
      'XFORGE_TRANSITION_ORPHAN_RECEIPT',
      `The current Stage rests on a Transition receipt that no stage.entered audit event attests, which is what a run killed between writing the receipt and recording the event leaves behind: ${listed}. The Stage advanced, but the audit chain never recorded that it did.`,
      receiptsPath,
      'warning',
      { receipts: unattested.orphans.map((receipt) => ({ receiptId: receipt.receiptId, sequence: receipt.sequence, from: receipt.from, to: receipt.to, digest: receipt.digest, attestation: transitionAttestationDigest(receipt.digest) })) },
    ));
    nextActions.push({
      action: 'reconcile-orphan-receipt',
      type: 'governance',
      actor: 'human',
      reason: `Do not delete the receipt: the Change's current Stage is derived from it and every later receipt chains to its digest, so removing it rewinds the Change and breaks that chain. Confirm instead whether the transition really happened — compare the receipt under ${receiptsPath} with \`xforge audit status --change ${options.change}\` and the committed evidence/audit/index.json. If it did, the gap is a missing audit event and the receipt is the surviving record of it; if the audit data is merely absent on this machine, restore xforge/.audit/** or the committed index from the tree that ran the transition and this warning clears on its own.`,
      command: ['xforge', 'audit', 'status', '--change', options.change],
    });
  }
  for (const receipt of unattested.incomplete) {
    diagnostics.push(diagnostic(
      'XFORGE_TRANSITION_RECEIPT_UNATTESTED',
      `Transition receipt ${receipt.receiptId} (${receipt.from} -> ${receipt.to}) has no stage.entered audit event, but a later receipt does — the audit data readable here is incomplete rather than a Transition having been interrupted. Nothing is blocked; the Stage history on disk stands.`,
      receiptsPath,
      'info',
    ));
  }

  const ready = !diagnostics.some((item) => item.severity === 'error');
  if (options.dryRun || !ready) return { data: { change: options.change, from: control.governance.currentStage, to: options.to, ready, receipt: null, dryRun: options.dryRun }, diagnostics, changes: [], nextActions };

  await recordAudit(project, { eventType: 'stage.entering', change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage, revision: control.governance.revision, decision: options.to, outcome: 'succeeded' });
  /*
   * The receipt binds to this Change's own chain head, not a project-wide rollup: `verifyAudit`
   * without a Change ID folds every shard's diagnostics into one `valid` flag, so a different
   * Change's corrupted shard would otherwise taint this receipt even though `blockedBy` above
   * already proved this Change's own chain is intact (`control-plane.ts`'s `audit:chain-invalid`).
   * A project-wide problem is still worth surfacing, just not as a hostage-taking hard block on
   * every other Change's transitions.
   */
  const ownAudit = await readChangeAuditEvents(project, options.change);
  const globalAudit = await verifyAudit(project);
  if (!globalAudit.valid) {
    diagnostics.push(diagnostic(
      'XFORGE_AUDIT_CHAIN_UNTRUSTED_ELSEWHERE',
      'This transition proceeded because this Change\'s own audit chain is intact, but a different Change\'s audit chain failed verification and the project-wide audit trail is not fully trustworthy. Run `xforge audit status` to locate the affected Change.',
      undefined,
      'warning',
    ));
  }
  const sequence = control.governance.transitions.length + 1;
  const unsigned = {
    apiVersion: 'xforge.dev/v1alpha2' as const, kind: 'TransitionReceipt' as const, receiptId: randomUUID(), sequence, change: options.change,
    flow: resolved.flow.metadata.name, from: control.governance.currentStage, to: options.to, contentRevision: control.governance.revision.contentRevision,
    stateRevisionBefore: control.governance.revision.stateRevision, policySnapshotDigest: control.governance.revision.policySnapshotDigest,
    gitHead: control.governance.revision.gitHead, previousReceiptDigest: control.governance.transitionHead, transitionedAt: new Date().toISOString(),
    actor: { id: process.env.XFORGE_ACTOR_ID ?? process.env.USER ?? 'unknown', provider: process.env.XFORGE_ACTOR_PROVIDER ?? 'local-os', type: process.env.XFORGE_ACTOR_TYPE === 'agent' ? 'agent' as const : 'human' as const },
    approvals: requirement.approvals.map((item) => item.digest).sort(), gates: requirement.gates.map((item) => item.digest).sort(), auditHead: ownAudit.chain.head,
  };
  const receipt: TransitionReceipt = { ...unsigned, digest: sha256(stableStringify(unsigned)) };
  const target = `${project.changesPath}/${options.change}/evidence/receipts/transitions/${String(sequence).padStart(4, '0')}-${receipt.receiptId}.json`;
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  await atomicWrite(project.root, target, content);
  try {
    const nextResolved = await resolveChangeState(project, options.change);
    const nextControl = await resolveControlPlane(project, options.change, nextResolved.flow as typeof resolved.flow, nextResolved.state, resources, nextResolved.config);
    /* The attestation digest comes from the shared definition in `core/audit.ts`, so the write side
       here and the orphan scan above cannot drift apart on what attests what. */
    await recordAudit(project, { eventType: 'stage.entered', change: options.change, flow: resolved.flow.metadata.name, stage: options.to, revision: nextControl.governance.revision, decision: options.to, outcome: 'succeeded', inputDigest: transitionAttestationDigest(receipt.digest) });
  } catch (error) {
    /*
     * State is derived from receipts on disk (see `control-plane.ts`), so an orphaned receipt with
     * no matching `stage.entered` audit event would silently advance the Change's stage anyway, and
     * a retry of the same transition would then fail confusingly as "already there." Compensate by
     * removing the receipt so the Change is left exactly where it was before this call.
     */
    await rm(await safeResolve(project.root, target), { force: true }).catch(() => undefined);
    throw error;
  }
  const change: FileChange = { action: 'create', path: target, digest: sha256(content), source: `transition:${receipt.from}:${receipt.to}` };
  return { data: { change: options.change, from: receipt.from, to: receipt.to, ready: true, receipt, dryRun: false }, diagnostics, changes: [change], nextActions };
}
