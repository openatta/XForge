import { randomUUID } from 'node:crypto';
import { link, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, FileChange, NextAction, ProjectContext, TransitionReceipt } from '../types.js';
import { readChangeAuditEvents, readTransitionAttestations, recordAudit, transitionAttestationDigest, verifyAudit } from '../core/audit.js';
import { blockRemedy, resolveControlPlane } from '../core/control-plane.js';
import { TRANSITION_RECEIPTS_RELATIVE, readTransitionReceiptFiles, transitionReceiptFileName } from '../core/control-plane/receipts.js';
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
/**
 * Creates a file at exactly one path, or fails because somebody was already there.
 *
 * `atomicWrite` (core/files.ts) is temp-file + rename, and rename replaces silently — it cannot
 * express "only if nobody got here first", which is the whole requirement for a Transition receipt:
 * the receipt at sequence N *is* the record that the Change moved once at that point, so a second
 * one is never a write to merge, it is a conflict to report. `link()` says both things at once: it
 * is atomic, so the content is complete before the name exists, and it fails with `EEXIST` rather
 * than overwriting a receipt the rest of the chain already hashes.
 */
async function createExclusive(root: string, relative: string, content: string): Promise<void> {
  const destination = await safeResolve(root, relative, { createParent: true });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.xforge-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await link(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

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

function transitionActor(): TransitionReceipt['actor'] {
  const declared = process.env.XFORGE_ACTOR_TYPE;
  return {
    id: process.env.XFORGE_ACTOR_ID ?? process.env.USER ?? 'unknown',
    provider: process.env.XFORGE_ACTOR_PROVIDER ?? 'local-os',
    type: declared === 'agent' || declared === 'human' ? declared : 'system',
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
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config, { workPackages });
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
  if (remedy) diagnostics.push(diagnostic(remedy.code, remedy.message, `${project.changesPath}/${options.change}`, 'info'));

  /*
   * Surfaced as a warning, not a block, and deliberately: the Stage this remnant advanced to is
   * already the Change's current Stage, and there is no `xforge audit repair`. Blocking would leave
   * the only exit the one this scan exists to avoid recommending — deleting governance evidence,
   * which rewinds `currentStage` and breaks the `previousReceiptDigest` chain of every later
   * receipt. A loud, repeated warning that names the receipt and the missing event leaves the
   * evidence intact and the decision with a human.
   */
  const receiptsPath = `${project.changesPath}/${options.change}/${TRANSITION_RECEIPTS_RELATIVE}`;
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
  if (options.dryRun || !ready) {
    /*
     * A rehearsal of a transition that would happen says which receipt it would write.
     *
     * This returned an empty plan for both cases at once, and they are not the same answer. A
     * blocked transition writes nothing, so nothing is the truth. A ready one writes a receipt, and
     * reporting no changes reads as "this would change nothing" — the one thing a rehearsal must not
     * say, and the rule `findings.ts` states in as many words two commands away.
     *
     * The path is knowable here: the filename comes from the sequence, which is derived from the
     * receipts already on disk. The digest is not — the receipt carries a fresh `receiptId` and the
     * moment it was written — so it is left off rather than guessed. A plan naming a path without
     * claiming bytes it cannot know is honest; one claiming a digest that will not match is not.
     */
    const planned: FileChange[] = ready
      ? [{
        action: 'create',
        path: `${receiptsPath}/${transitionReceiptFileName(Math.max(0, ...control.governance.transitions.map((receipt) => receipt.sequence)) + 1)}`,
        source: `transition:${control.governance.currentStage}:${options.to}`,
      }]
      : [];
    return { data: { change: options.change, from: control.governance.currentStage, to: options.to, ready, receipt: null, dryRun: options.dryRun }, diagnostics, changes: planned, nextActions };
  }

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
  /*
   * Derived from the highest sequence on disk, not from how many receipts there are. Counting made
   * the number a function of the *set*, so a Change whose chain had a gap — or that had just been
   * repaired — reissued a sequence some receipt already used, and two receipts at the same sequence
   * is the one shape the chain cannot resolve. `max + 1` is a function of the history instead, which
   * is what a sequence is supposed to be.
   */
  const sequence = Math.max(0, ...control.governance.transitions.map((receipt) => receipt.sequence)) + 1;
  const unsigned = {
    apiVersion: 'xforge.dev/v1alpha2' as const, kind: 'TransitionReceipt' as const, receiptId: randomUUID(), sequence, change: options.change,
    flow: resolved.flow.metadata.name, from: control.governance.currentStage, to: options.to, contentRevision: control.governance.revision.contentRevision,
    stateRevisionBefore: control.governance.revision.stateRevision, policySnapshotDigest: control.governance.revision.policySnapshotDigest,
    gitHead: control.governance.revision.gitHead, previousReceiptDigest: control.governance.transitionHead, transitionedAt: new Date().toISOString(),
    /*
     * `system` when nothing says otherwise, not `human`.
     *
     * The default used to be `human`, so a receipt written by an unattended process claimed a person
     * performed the transition -- an unearned claim of exactly the kind `decidedBy`, `resolvedBy` and
     * the approval dialogue all exist to refuse. `XFORGE_ACTOR_TYPE` is still only an assertion, but
     * an absent one now reads as "nobody said" rather than as "a person did it", and it agrees with
     * what the audit chain records for the same operation (`ambientActor` in `core/audit.ts`).
     */
    actor: transitionActor(),
    approvals: requirement.approvals.map((item) => item.digest).sort(), gates: requirement.gates.map((item) => item.digest).sort(), auditHead: ownAudit.chain.head,
  };
  const receipt: TransitionReceipt = { ...unsigned, digest: sha256(stableStringify(unsigned)) };
  const target = `${receiptsPath}/${transitionReceiptFileName(sequence)}`;
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    await createExclusive(project.root, target, content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    /*
     * The receipt name no longer carries a UUID, so this is where a second writer for the same
     * sequence lands instead of quietly forking the chain — another process racing this one, or a
     * branch that already recorded this transition. Refusing here leaves the Change exactly as it
     * was; the `stage.entering` event above records the attempt, which is what it is for.
     */
    throw new XForgeError(diagnostic(
      'XFORGE_TRANSITION_RECEIPT_EXISTS',
      `A Transition receipt for sequence ${sequence} already exists at ${target}, so this Stage transition has already been recorded. Re-read the Change with \`xforge state --change ${options.change}\` before transitioning again; do not delete the existing receipt, every later receipt chains to its digest.`,
      target,
    ));
  }
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
  /*
   * This write is the reason the next `stage-bundle` will refuse to be useful.
   *
   * `stage-bundle` computes what moved with `git diff <the Stage's gitHead>..HEAD`, so it answers
   * about commits and an uncommitted edit voids every voucher — deliberately, because reporting
   * "unchanged" about a file that changed is worse than the re-reading it saves. The receipt
   * written a line above is exactly such an edit, which makes the first `stage-bundle` of every
   * Stage fall back to "read all of it" unless the receipt is committed first.
   *
   * An end-to-end run hit this at the first transition and inferred the cause; nothing said it. The
   * command that creates the condition is the one that can name it, so it does.
   */
  diagnostics.push(diagnostic(
    'XFORGE_TRANSITION_RECEIPT_UNCOMMITTED',
    `This transition wrote ${target}, so the Change directory now has an uncommitted edit. \`xforge stage-bundle --change ${options.change}\` compares commits, and any uncommitted edit under the Change makes it list every Artifact to be read in full rather than the short set that actually moved. Commit the receipt before running it.`,
    target,
    'info',
  ));
  return { data: { change: options.change, from: receipt.from, to: receipt.to, ready: true, receipt, dryRun: false }, diagnostics, changes: [change], nextActions };
}

/**
 * The way out of a broken Transition chain, without deleting evidence blind.
 *
 * A forked chain used to have no exit at all: every command on the Change failed, and the tool's own
 * guidance for a receipt anomaly is "do not delete the receipt", correctly, because the current
 * Stage is derived from the last receipt and every later receipt hashes the one before it. The
 * chain-invalid diagnostic is a targeted block now (see `core/control-plane.ts`), which makes a
 * repair both possible and necessary — this is it.
 *
 * The rule that keeps it honest is that only a *leaf* may go: a receipt whose digest appears as some
 * other receipt's `previousReceiptDigest` is load-bearing, and removing it would orphan work that
 * was recorded on top of it. Choosing between two leaves is a judgement about which history actually
 * happened, so the caller names the receipt; this function refuses everything else and records what
 * it did in the audit chain, because a repair is itself a governance act.
 */
export async function repairTransitionChain(project: ProjectContext, options: { change: string; receiptId: string; dryRun: boolean }): Promise<{
  data: { change: string; dropped: TransitionReceipt | null; renumbered: Array<{ receiptId: string; from: number; to: number }>; dryRun: boolean };
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'transition repair');
  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) {
    throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', 'transition repair requires a Protocol 2 governed Flow.'));
  }
  const loaded = await readTransitionReceiptFiles(project, options.change, resolved.flow);
  const receiptsPath = `${project.changesPath}/${options.change}/${TRANSITION_RECEIPTS_RELATIVE}`;
  const target = loaded.files.find((file) => file.receipt.receiptId === options.receiptId);
  if (!target) {
    throw new XForgeError(diagnostic(
      'XFORGE_TRANSITION_REPAIR_UNKNOWN_RECEIPT',
      `No Transition receipt with receiptId ${options.receiptId} exists for Change ${options.change}. \`xforge state --change ${options.change}\` lists the chain, and the XFORGE_TRANSITION_CHAIN_INVALID diagnostic names which receipts can be dropped.`,
      receiptsPath,
    ));
  }
  const dependent = loaded.files.filter((file) => file.receipt.previousReceiptDigest === target.receipt.digest);
  if (dependent.length > 0) {
    throw new XForgeError(diagnostic(
      'XFORGE_TRANSITION_REPAIR_RECEIPT_REFERENCED',
      `Transition receipt ${options.receiptId} cannot be dropped: ${dependent.map((file) => `${file.receipt.receiptId} (sequence ${file.receipt.sequence})`).join(', ')} chain${dependent.length === 1 ? 's' : ''} to its digest. Drop the leaf of the branch you are discarding, not the receipt the surviving history was built on.`,
      target.relative,
    ));
  }

  const diagnostics: Diagnostic[] = [...loaded.diagnostics];
  const remaining = loaded.files.filter((file) => file !== target);
  /*
   * Renumbering exists for the gap a drop can leave, and is done only when there is one: rewriting a
   * receipt changes its digest, which invalidates the `stage.entered` attestation recorded for it
   * and every `previousReceiptDigest` after it. Dropping a fork's leaf normally leaves the surviving
   * branch already contiguous, so the common repair rewrites nothing at all.
   */
  const rewrites: Array<{ file: typeof loaded.files[number]; receipt: TransitionReceipt; relative: string }> = [];
  const renumbered: Array<{ receiptId: string; from: number; to: number }> = [];
  let previousDigest: string | null = null;
  for (const [index, file] of remaining.entries()) {
    const sequence = index + 1;
    if (file.receipt.sequence === sequence && file.receipt.previousReceiptDigest === previousDigest) {
      previousDigest = file.receipt.digest;
      continue;
    }
    const { digest: _digest, ...unsigned } = { ...file.receipt, sequence, previousReceiptDigest: previousDigest };
    const receipt: TransitionReceipt = { ...unsigned, digest: sha256(stableStringify(unsigned)) };
    rewrites.push({ file, receipt, relative: `${receiptsPath}/${transitionReceiptFileName(sequence)}` });
    if (file.receipt.sequence !== sequence) renumbered.push({ receiptId: receipt.receiptId, from: file.receipt.sequence, to: sequence });
    previousDigest = receipt.digest;
  }
  if (rewrites.length > 0) {
    diagnostics.push(diagnostic(
      'XFORGE_TRANSITION_CHAIN_RENUMBERED',
      `Repairing the chain rewrites ${rewrites.length} later receipt(s) so the sequence stays contiguous. Their digests change, so the stage.entered audit events recorded for them no longer attest them and the orphan scan will report them as unattested until the audit data is reconciled.`,
      receiptsPath, 'warning',
      { receipts: rewrites.map((item) => ({ receiptId: item.receipt.receiptId, sequence: item.receipt.sequence, previousDigest: item.file.receipt.digest, digest: item.receipt.digest })) },
    ));
  }

  const changes: FileChange[] = [
    { action: 'delete', path: target.relative, digest: target.receipt.digest, source: `transition-repair:${target.receipt.from}:${target.receipt.to}` },
    ...rewrites.map((item): FileChange => ({ action: 'move', path: item.relative, from: item.file.relative, digest: item.receipt.digest, source: `transition-repair:renumber:${item.receipt.sequence}` })),
  ];
  if (options.dryRun) return { data: { change: options.change, dropped: target.receipt, renumbered, dryRun: true }, diagnostics, changes };

  /* The dropped file goes first, and it has to: a renumbered receipt can land on exactly the path
     the dropped one occupied, and removing that path afterwards would delete the rewrite instead.
     Ascending order then keeps the rewrites from colliding — a repair only ever shrinks sequences,
     so each destination is vacated by the receipt handled before it. */
  await rm(await safeResolve(project.root, target.relative), { force: true });
  for (const item of rewrites) {
    await atomicWrite(project.root, item.relative, `${JSON.stringify(item.receipt, null, 2)}\n`);
    if (item.file.relative !== item.relative) await rm(await safeResolve(project.root, item.file.relative), { force: true });
  }
  /* A repair is a governance act, so it leaves a record of exactly what was discarded — otherwise
     the only trace of the dropped receipt is its absence, which is indistinguishable from tampering. */
  await recordAudit(project, {
    eventType: 'transition.repaired', change: options.change, flow: resolved.flow.metadata.name,
    stage: remaining.at(-1)?.receipt.to ?? resolved.flow.stages[0]?.id ?? null,
    decision: `drop:${target.receipt.receiptId}`, outcome: 'succeeded',
    inputDigest: transitionAttestationDigest(target.receipt.digest),
    output: { dropped: target.receipt.digest, from: target.receipt.from, to: target.receipt.to, sequence: target.receipt.sequence, renumbered },
  });
  return { data: { change: options.change, dropped: target.receipt, renumbered, dryRun: false }, diagnostics, changes };
}
