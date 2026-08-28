import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalPolicy, ApprovalReceipt, Diagnostic, ProjectContext, StageFlow, TransitionReceipt } from '../../types.js';
import { approvalVerifiedInChain } from '../audit.js';
import { verifyApprovalReceipt } from '../approval-receipt.js';
import { diagnostic } from '../errors.js';
import { sha256, stableStringify } from '../hash.js';
import { safeResolve } from '../path-safety.js';
import { validateSchema } from '../validator.js';
import { legalTransitionTargets } from './graph.js';

/**
 * Reading the receipts a Change has accumulated, and refusing the ones that do not check out.
 *
 * Two kinds -- transition and approval -- and the same posture toward both: a receipt is only worth
 * what its validation is worth, so a digest that does not recompute, a subject naming another
 * Change, or a chain that does not resolve to one history drops the record rather than qualifying
 * it. Every field on a receipt is computable by whoever wrote the file, which is why a
 * self-covering hash proves internal consistency and nothing more; what it cannot forge is the audit
 * chain, and that is what `approvalVerifiedInChain` is doing here.
 *
 * Separated from the resolver because this layer answers only "is this a receipt". Whether the
 * receipts a Change holds are enough to move it is the resolver's question.
 */

function receiptDigest<T extends { digest: string }>(receipt: T): string {
  const { digest: _digest, ...unsigned } = receipt;
  return sha256(stableStringify(unsigned));
}
async function jsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
}
export const TRANSITION_RECEIPTS_RELATIVE = 'evidence/receipts/transitions';
/**
 * Where the Transition receipt for `sequence` lives.
 *
 * The name used to embed a fresh UUID, which meant two receipts claiming the same sequence never
 * collided on disk — not between two processes, and not between two branches, where `git merge`
 * sees two *added* files in one directory and takes both without a conflict. The chain then holds
 * two sequence-N receipts and every operation on the Change fails on `XFORGE_TRANSITION_CHAIN_INVALID`.
 * A sequence-derived name makes that collision impossible to miss: a second writer gets EEXIST, and
 * a merge gets an add/add conflict on one path, which is a question Git puts to a human rather than
 * a fork it commits silently.
 */
export function transitionReceiptFileName(sequence: number): string {
  return `${String(sequence).padStart(4, '0')}.json`;
}
/** A Transition receipt together with the file it came from, for callers that must rewrite it. */
interface TransitionReceiptFile {
  name: string;
  relative: string;
  receipt: TransitionReceipt;
}
/**
 * Every structurally valid Transition receipt on disk, in sequence order, with its filename.
 *
 * Split out of `loadTransitionReceipts` so the repair path can address individual files: continuity
 * is a property of the set, but dropping or renumbering a receipt is an operation on one path.
 */
export async function readTransitionReceiptFiles(
  project: ProjectContext,
  changeId: string,
  flow: StageFlow,
): Promise<{ files: TransitionReceiptFile[]; diagnostics: Diagnostic[] }> {
  const relative = `${project.changesPath}/${changeId}/${TRANSITION_RECEIPTS_RELATIVE}`;
  const directory = await safeResolve(project.root, relative);
  const diagnostics: Diagnostic[] = [];
  const files: TransitionReceiptFile[] = [];
  for (const name of await jsonFiles(directory)) {
    const receiptPath = `${relative}/${name}`;
    let receipt: TransitionReceipt;
    try { receipt = JSON.parse(await readFile(await safeResolve(project.root, receiptPath), 'utf8')) as TransitionReceipt; }
    catch (error) {
      diagnostics.push(diagnostic('XFORGE_TRANSITION_RECEIPT_INVALID', `Transition receipt is not valid JSON: ${(error as Error).message}`, receiptPath));
      continue;
    }
    const receiptDiagnostics = await validateSchema('transition-receipt', receipt, receiptPath);
    if (receipt.digest !== receiptDigest(receipt)) receiptDiagnostics.push(diagnostic('XFORGE_TRANSITION_RECEIPT_DIGEST_INVALID', 'Transition receipt digest is invalid.', receiptPath));
    if (receipt.change !== changeId || receipt.flow !== flow.metadata.name) receiptDiagnostics.push(diagnostic('XFORGE_TRANSITION_RECEIPT_SUBJECT_MISMATCH', 'Transition receipt is bound to a different Change or Flow.', receiptPath));
    diagnostics.push(...receiptDiagnostics);
    if (receiptDiagnostics.some((item) => item.severity === 'error')) continue;
    files.push({ name, relative: receiptPath, receipt });
  }
  files.sort((left, right) => left.receipt.sequence - right.receipt.sequence);
  return { files, diagnostics };
}
export async function loadTransitionReceipts(
  project: ProjectContext,
  changeId: string,
  flow: StageFlow,
): Promise<{ receipts: TransitionReceipt[]; diagnostics: Diagnostic[]; chainValid: boolean }> {
  const relative = `${project.changesPath}/${changeId}/${TRANSITION_RECEIPTS_RELATIVE}`;
  const loaded = await readTransitionReceiptFiles(project, changeId, flow);
  const diagnostics = [...loaded.diagnostics];
  const receipts = loaded.files.map((file) => file.receipt);
  /* A digest some other receipt chains to cannot be dropped without orphaning that successor; one
     nothing chains to is a leaf, and a leaf is the only thing `repairTransitionChain` may remove.
     Reported per break so the operator is told which of the two receipts is the removable one. */
  const referenced = new Set(receipts.map((receipt) => receipt.previousReceiptDigest).filter((digest): digest is string => typeof digest === 'string'));
  let previous: TransitionReceipt | null = null;
  let current = flow.stages[0]?.id ?? 'unknown';
  let chainValid = true;
  for (const receipt of receipts) {
    /*
     * `to` has to be a Stage the Flow can actually reach from `from`. Nothing checked this before,
     * and the schema leaves both as free strings, so a receipt asserting `design -> ready-to-archive`
     * cleared Check, Apply and Verify in one file. This stays an error rather than the warning the
     * continuity break below carries: a clean `git merge` can produce a forked chain out of two
     * honest developers, but no honest run produces a transition the graph does not contain, so the
     * receipt is not evidence of a legitimate transition and the Change must not be read as if it
     * were. The way out is the same repair path — the receipt is a leaf, so it can be dropped.
     */
    const legal = legalTransitionTargets(flow, receipt.from);
    if (!legal.includes(receipt.to)) {
      chainValid = false;
      diagnostics.push(diagnostic(
        'XFORGE_TRANSITION_UNREACHABLE_STAGE',
        `Transition receipt ${receipt.receiptId} (sequence ${receipt.sequence}) claims ${receipt.from} -> ${receipt.to}, which Flow ${flow.metadata.name} does not allow. Legal transitions out of ${receipt.from}: ${legal.length > 0 ? legal.join(', ') : 'none — the Flow does not declare that Stage'}.`,
        relative, 'error',
        { receiptId: receipt.receiptId, sequence: receipt.sequence, from: receipt.from, to: receipt.to, legalTargets: legal, droppable: !referenced.has(receipt.digest) },
      ));
    }
    if (receipt.sequence !== (previous?.sequence ?? 0) + 1 || receipt.previousReceiptDigest !== (previous?.digest ?? null) || receipt.from !== current) {
      chainValid = false;
      /*
       * Warning, not error, and this is the whole point of the downgrade. `control.diagnostics` is
       * spread into the blocking set of every consumer (`commands/transition.ts`,
       * `commands/work-package.ts`, `core/archiver.ts`, `core/state-reader.ts`), so an error here
       * killed the Change outright — `xforge state` could not even report what was wrong, and the
       * tool's own guidance for receipt anomalies says not to delete the receipt. The condition is
       * now a targeted block instead: every transition and archive is refused (see
       * `resolveControlPlane` and `terminalGovernanceBlocks`), while reading the Change, running
       * Gates and repairing the chain all still work.
       */
      const duplicate = previous?.sequence === receipt.sequence ? previous : null;
      diagnostics.push(diagnostic(
        'XFORGE_TRANSITION_CHAIN_INVALID',
        duplicate
          ? `Two Transition receipts claim sequence ${receipt.sequence}: ${duplicate.receiptId} (${duplicate.from} -> ${duplicate.to}) and ${receipt.receiptId} (${receipt.from} -> ${receipt.to}). Two branches recorded a Stage transition from the same point and the merge kept both. Drop the one no later receipt builds on to repair the chain.`
          : `Transition chain is invalid at sequence ${receipt.sequence} (${receipt.receiptId}): expected sequence ${(previous?.sequence ?? 0) + 1} continuing from ${current}, found ${receipt.sequence} from ${receipt.from}.`,
        relative, 'warning',
        {
          receiptId: receipt.receiptId, sequence: receipt.sequence, from: receipt.from, to: receipt.to,
          expectedSequence: (previous?.sequence ?? 0) + 1, expectedFrom: current,
          duplicateOf: duplicate?.receiptId ?? null,
          droppable: [receipt, ...(duplicate ? [duplicate] : [])].filter((item) => !referenced.has(item.digest)).map((item) => item.receiptId),
        },
      ));
    }
    previous = receipt;
    current = receipt.to;
  }
  return { receipts, diagnostics, chainValid };
}
export async function loadApprovalReceipts(
  project: ProjectContext,
  changeId: string,
): Promise<{ receipts: ApprovalReceipt[]; diagnostics: Diagnostic[] }> {
  const rootRelative = `${project.changesPath}/${changeId}/approvals`;
  const root = await safeResolve(project.root, rootRelative);
  const diagnostics: Diagnostic[] = [];
  const receipts: ApprovalReceipt[] = [];
  let policyDirectories: string[] = [];
  try { policyDirectories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch { return { receipts, diagnostics }; }
  for (const policy of policyDirectories) {
    const directory = path.join(root, policy);
    for (const name of await jsonFiles(directory)) {
      const relative = `${rootRelative}/${policy}/${name}`;
      let receipt: ApprovalReceipt;
      try { receipt = JSON.parse(await readFile(await safeResolve(project.root, relative), 'utf8')) as ApprovalReceipt; }
      catch (error) {
        diagnostics.push(diagnostic('XFORGE_APPROVAL_RECEIPT_INVALID', `Approval receipt is not valid JSON: ${(error as Error).message}`, relative));
        continue;
      }
      const receiptDiagnostics = await validateSchema('approval-receipt', receipt, relative);
      receiptDiagnostics.push(...verifyApprovalReceipt(project, receipt).map((item) => ({ ...item, path: relative })));
      if (receipt.change !== changeId || receipt.policyId !== policy) receiptDiagnostics.push(diagnostic('XFORGE_APPROVAL_RECEIPT_SUBJECT_MISMATCH', 'Approval receipt path does not match its subject.', relative));
      /*
       * Neither `local` nor `mcp` receipts carry a signature, so `verifyApprovalReceipt` above is
       * structural only (digest self-consistency, provider/role authorized) — it cannot by itself
       * distinguish a receipt `approve` actually produced from one someone hand-placed on disk.
       * Authenticity comes from the project's own tamper-evident audit hash chain: `approve` always
       * records an `approval.decided` event carrying `sha256({policy, receipt: receipt.digest})`
       * alongside writing the receipt file, in the same run. A receipt with no matching chain event
       * never went through `approve` and is rejected outright, regardless of how well-formed it
       * looks. This is required unconditionally — for both approval mechanisms XForge supports
       * (the CLI's own interactive terminal and an mcp provider) — not only as a fallback.
       */
      const chainVerified = await approvalVerifiedInChain(project, changeId, policy, receipt.digest);
      if (!chainVerified) {
        /*
         * Warning, not error: this receipt is excluded from `receipts` below regardless, so a
         * policy that actually needs it still reports `approval:<id>:missing-N` with a reason that
         * names the real problem. Reporting it as an error here would instead make
         * `executeTransition`'s whole-diagnostic-bag readiness test refuse transitions that need no
         * approval at all, purely because some earlier, already-consumed receipt (e.g. one issued
         * before per-Change audit sharding existed, or read before its committed index caught up)
         * cannot be corroborated.
         */
        receiptDiagnostics.push(diagnostic(
          'XFORGE_APPROVAL_NOT_IN_AUDIT_CHAIN',
          'No approval.decided event in this Change\'s audit chain matches this receipt; it did not come from `xforge approve` and cannot be trusted.',
          relative, 'warning',
        ));
      }
      diagnostics.push(...receiptDiagnostics);
      if (!chainVerified || receiptDiagnostics.some((item) => item.severity === 'error')) continue;
      receipts.push(receipt);
    }
  }
  return { receipts, diagnostics };
}
/**
 * What an Approval receipt has to be bound to in order to still count.
 *
 * `governingRevision` is the current binding; `stateRevision` is only consulted for receipts issued
 * before the split, which never carried a governing revision.
 */
export interface ApprovalBinding {
  governingRevision: string;
  stateRevision: string;
  /** Identities that did the work on this Change; an approver inside this set fails separation of duties. */
  implementers?: ReadonlySet<string>;
  now?: number;
}
export function boundToRevision(receipt: ApprovalReceipt, binding: ApprovalBinding): boolean {
  return receipt.governingRevision
    ? receipt.governingRevision === binding.governingRevision
    : receipt.stateRevision === binding.stateRevision;
}
/**
 * One human, one key.
 *
 * `minApprovers` used to count receipts keyed on the raw `approver.id` while separation of duties
 * compared the same field trimmed and lowercased, so `alice` and `Alice` were two approvers to one
 * rule and one person to the other — in this file. Both now go through here.
 *
 * The provider is deliberately not part of the key. The same person reached through `local` and
 * through an mcp provider is still one person, and folding the provider in would let a single
 * approver satisfy Major's `minApprovers: 2` by deciding twice through two routes — the opposite of
 * what the policy is asking for. Widening the key can only ever make approval easier, so this stays
 * as narrow as the identity it represents.
 */
function actorIdentity(id: string): string {
  return id.trim().toLowerCase();
}
/** Compares an approver identity against Git author identities case-insensitively. */
function isImplementer(receipt: ApprovalReceipt, implementers: ReadonlySet<string> | undefined): boolean {
  if (!implementers || implementers.size === 0) return false;
  return implementers.has(actorIdentity(receipt.approver.id));
}
export function approvalsForPolicy(
  receipts: ApprovalReceipt[],
  policy: ApprovalPolicy,
  transition: string,
  binding: ApprovalBinding,
): { valid: ApprovalReceipt[]; missing: number; rejected: boolean; separationSatisfied: boolean; selfApprovers: string[] } {
  const now = binding.now ?? Date.now();
  const applicable = receipts.filter((receipt) => receipt.policyId === policy.id && receipt.transition === transition && boundToRevision(receipt, binding) &&
    (!receipt.expiresAt || Date.parse(receipt.expiresAt) > now) && policy.providers.includes(receipt.approver.provider) && policy.roles.includes(receipt.approver.role));
  const rejected = applicable.some((receipt) => receipt.decision === 'reject');
  const byActor = new Map(applicable.filter((receipt) => receipt.decision === 'approve').map((receipt) => [actorIdentity(receipt.approver.id), receipt]));
  /*
   * Separation of duties means the approver is not the implementer. The previous rule counted
   * distinct roles instead, which both let the author of the change approve it and rejected the
   * most common real review shape -- two different maintainers.
   */
  const selfApproved = policy.separationOfDuties
    ? [...byActor.values()].filter((receipt) => isImplementer(receipt, binding.implementers))
    : [];
  /* Reported with the spelling the receipt actually carries; compared on the normalized identity. */
  const selfApprovers = selfApproved.map((receipt) => receipt.approver.id);
  const selfIdentities = new Set(selfApproved.map((receipt) => actorIdentity(receipt.approver.id)));
  const valid = [...byActor.values()].filter((receipt) => !selfIdentities.has(actorIdentity(receipt.approver.id)));
  const missing = Math.max(0, policy.minApprovers - valid.length);
  /* A self-approval never counts. It is only reported as a violation while it is what is missing. */
  return { valid, missing, rejected, separationSatisfied: selfApprovers.length === 0 || missing === 0, selfApprovers };
}
