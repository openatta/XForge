import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ApprovalPolicy,
  ApprovalReceipt,
  ChangeState,
  Diagnostic,
  GateEvidence,
  GovernanceState,
  ProjectContext,
  StageFlow,
  TransitionReceipt,
} from '../types.js';
import { diagnostic } from './errors.js';
import { normalizeRule, policyApplies, ruleApplies } from './governance.js';
import { sha256, stableStringify } from './hash.js';
import { safeResolve } from './path-safety.js';
import type { SelectedResources } from './resource-loader.js';
import { changeImplementers, computeGovernanceRevision } from './revision.js';
import { validateSchema } from './validator.js';
import { approvalVerifiedInChain, readChangeAuditEvents, type ChangeAuditFacts } from './audit.js';
import { verifyApprovalReceipt } from './approval-receipt.js';
import { knownIdentities, unknownIdentityReason, type KnownIdentities } from './ledger-identity.js';
import { VERIFICATION_RECEIPT_CONDITION, evaluateVerificationReceipt } from './verification-receipt.js';
import { parse as parseYaml } from 'yaml';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

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

/**
 * The Stages a Change may move to from `from`, as the Flow graph declares them.
 *
 * One source of truth for two readers that used to disagree by omission. `resolveControlPlane`
 * offers exactly these as transition candidates, but the receipt chain never consulted the graph at
 * all: it checked `sequence`, `previousReceiptDigest` and `from`, and took `to` on the receipt's
 * word. A hand-written receipt could therefore claim `design -> ready-to-archive`, skipping Check,
 * Apply and Verify — and `terminalGovernanceBlocks` would then re-check the Gates of whatever
 * `from` that receipt named, which is exactly the Stage the skip was designed to leave behind.
 */
export function legalTransitionTargets(flow: StageFlow, from: string): string[] {
  const index = flow.stages.findIndex((stage) => stage.id === from);
  if (index < 0) return [];
  const stage = flow.stages[index]!;
  const targets: string[] = [];
  targets.push(index < flow.stages.length - 1 ? flow.stages[index + 1]!.id : 'ready-to-archive');
  for (const rework of stage.reworkTo ?? []) if (rework !== stage.id && !targets.includes(rework)) targets.push(rework);
  return targets;
}

/** A Transition receipt together with the file it came from, for callers that must rewrite it. */
export interface TransitionReceiptFile {
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

function boundToRevision(receipt: ApprovalReceipt, binding: ApprovalBinding): boolean {
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

function structuredExit(stage: StageFlow['stages'][number]): { conditions?: Record<string, string>; gates?: string[]; approvals?: string[]; auditEvents?: string[] } {
  const exit = stage.exit;
  if (!exit || !('conditions' in exit || 'gates' in exit || 'approvals' in exit || 'auditEvents' in exit)) return {};
  return exit;
}

async function readGateEvidence(project: ProjectContext, changeId: string, gateId: string, resources: SelectedResources): Promise<GateEvidence | null> {
  const gate = resources.gates.get(gateId)?.value;
  if (!gate) return null;
  const evidencePath = `${project.changesPath}/${changeId}/evidence/${gate.spec.evidence}`;
  const absolute = await safeResolve(project.root, evidencePath);
  if (!await exists(absolute)) return null;
  try {
    const evidence = JSON.parse(await readFile(absolute, 'utf8')) as GateEvidence;
    const { digest, ...unsigned } = evidence;
    return digest === sha256(stableStringify(unsigned)) && evidence.gate === gateId && evidence.change === changeId ? evidence : null;
  } catch { return null; }
}

function policyById(flow: StageFlow, id: string): ApprovalPolicy | null {
  return flow.governance?.approvalPolicies.find((policy) => policy.id === id) ?? null;
}

function providerKinds(project: ProjectContext, policy: ApprovalPolicy): Array<{ id: string; type: 'local' | 'mcp' }> {
  return policy.providers.map((id) => {
    if (id === 'local') return { id, type: 'local' as const };
    return { id, type: project.manifest.approvals?.providers.find((item) => item.id === id)?.type ?? 'mcp' };
  });
}

const CONDITION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface ConditionLedgerEntry {
  id?: unknown;
  question?: unknown;
  impact?: unknown;
  decision?: unknown;
  decidedBy?: unknown;
  decidedAt?: unknown;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function entryDecided(entry: ConditionLedgerEntry, known?: KnownIdentities): boolean {
  if (!(nonEmptyString(entry.question) && nonEmptyString(entry.decision) && nonEmptyString(entry.decidedBy)
    && nonEmptyString(entry.decidedAt) && !Number.isNaN(Date.parse(entry.decidedAt as string)))) return false;
  /* A decision has to be attributable to somebody the repository has actually seen; a non-empty
     string let a live run get away with `decidedBy: XForge Live E2E`. */
  return known ? unknownIdentityReason(entry.decidedBy, known) === null : true;
}

/**
 * Stage exit conditions are decided from a structured ledger, never from Artifact prose.
 *
 * The previous implementation regex-searched the Worker's own markdown for `<key>: <expected>`, so
 * an Agent could clear a governance condition by typing one line into a file it wrote itself --
 * exactly the "self-reported exit" that `xforge-apply` forbids as Gate Evidence. A condition now
 * requires `<change>/evidence/conditions/<key>.yaml` where every entry names a decision and a
 * decision maker, which cannot be satisfied without asserting an attributable human decision.
 */
async function evaluateExitCondition(
  project: ProjectContext,
  changeId: string,
  key: string,
  expected: string,
  known?: KnownIdentities,
): Promise<{ satisfied: boolean; reason: string }> {
  if (!CONDITION_KEY_PATTERN.test(key)) return { satisfied: false, reason: 'invalid-key' };
  let document: unknown = null;
  let found = false;
  for (const extension of ['yaml', 'yml', 'json']) {
    const relative = `${project.changesPath}/${changeId}/evidence/conditions/${key}.${extension}`;
    let source: string;
    try { source = await readFile(await safeResolve(project.root, relative), 'utf8'); }
    catch { continue; }
    found = true;
    try { document = extension === 'json' ? JSON.parse(source) : parseYaml(source, { strict: true, uniqueKeys: true }); }
    catch { return { satisfied: false, reason: 'ledger-unreadable' }; }
    break;
  }
  if (!found) return { satisfied: false, reason: `ledger-missing-expected-${expected}` };
  const ledger = document as { condition?: unknown; status?: unknown; entries?: unknown } | null;
  if (!ledger || typeof ledger !== 'object') return { satisfied: false, reason: 'ledger-unreadable' };
  if (nonEmptyString(ledger.condition) && ledger.condition !== key) return { satisfied: false, reason: 'ledger-subject-mismatch' };
  const entries = Array.isArray(ledger.entries) ? ledger.entries as ConditionLedgerEntry[] : null;
  if (!entries) return { satisfied: false, reason: 'entries-missing' };
  /*
   * An explicit `entries: []` is an assertion — "this Change raised no material questions" — and it
   * is the same assertion `core/check-findings.ts` accepts as `findings: []`, which this ledger was
   * written to mirror. Rejecting it stranded every Major Change that genuinely had nothing to
   * clarify: the clarify Stage declares no Gates and no Approvals, so `condition:materialQuestions`
   * is its only blocker, and the only way to clear it was to invent a question and attribute a
   * decision to a named human — the exact falsification the ledger exists to prevent.
   *
   * The absent and the empty case stay distinct, which is what makes the empty one an assertion
   * rather than an oversight: a missing file is still `ledger-missing-*`, an unreadable or
   * contentless one `ledger-unreadable`, and a ledger with no `entries` key at all `entries-missing`.
   * Only a list that is present and deliberately empty reaches the `status` check below.
   */
  const undecided = entries.filter((entry) => !entry || typeof entry !== 'object' || !entryDecided(entry, known));
  if (undecided.length > 0) return { satisfied: false, reason: `undecided-${undecided.length}` };
  const declared = nonEmptyString(ledger.status) ? ledger.status.trim() : 'resolved';
  if (declared !== expected) return { satisfied: false, reason: `status-${declared}-expected-${expected}` };
  return { satisfied: true, reason: 'satisfied' };
}

/**
 * The one exit condition that is not decided from `evidence/conditions/<key>.yaml`.
 *
 * `verification-receipt` is required by all three shipped Flows, and until now its only check was
 * `core/flow-resolver.ts`'s "the file exists and is not empty" — so `echo x >
 * evidence/verification-receipt.yaml` closed the Verify Stage. That is the self-reported exit
 * `core/check-findings.ts` was written to eliminate, still standing in the last Stage before
 * archive. The receipt lives at its own Flow-declared path rather than under `evidence/conditions/`,
 * and it is decided against facts this resolve already holds (the content revision and the Gate
 * Evidence that actually passed), so it is routed here instead of through the generic ledger reader.
 */
async function evaluateVerificationReceiptCondition(
  project: ProjectContext,
  changeId: string,
  expected: string,
  contentRevision: string,
  gates: readonly GateEvidence[],
): Promise<{ satisfied: boolean; reason: string }> {
  const result = await evaluateVerificationReceipt(project, changeId, { contentRevision, gates });
  if (result.status !== 'passed') return { satisfied: false, reason: result.reason };
  if (expected !== 'passed') return { satisfied: false, reason: `status-passed-expected-${expected}` };
  return { satisfied: true, reason: 'satisfied' };
}

export interface ResolvedControlPlane {
  governance: GovernanceState;
  diagnostics: Diagnostic[];
  flow: StageFlow;
  state: ChangeState;
  transitionRequirements: Map<string, { approvals: ApprovalReceipt[]; gates: GateEvidence[]; blockedBy: string[] }>;
  resources: SelectedResources;
  /** Audit facts for this Change as of this resolution, usable without the local `.audit` chain. */
  auditFacts: ChangeAuditFacts;
  /**
   * False when the Transition receipts on disk do not form one unbroken chain.
   *
   * Carried here rather than left to `control.diagnostics.some(...)` because it decides a block, not
   * a message: every candidate transition and archive is refused while it is false, and both of
   * those refusals must agree with the diagnostic that explains them.
   */
  transitionChainValid: boolean;
}

export async function resolveControlPlane(
  project: ProjectContext,
  changeId: string,
  flow: StageFlow,
  state: ChangeState,
  resources: SelectedResources,
  config: { scope: { modules: string[]; paths: string[] }; classification: any; flow: string },
): Promise<ResolvedControlPlane> {
  const diagnostics: Diagnostic[] = [];
  const transitions = await loadTransitionReceipts(project, changeId, flow);
  const approvals = await loadApprovalReceipts(project, changeId);
  /* Identities the repository actually records, so a ledger can cite a decision-maker but not
     invent one. Computed once per resolve and shared by every condition ledger. */
  const identities = await knownIdentities(project, changeId, approvals.receipts);
  diagnostics.push(...transitions.diagnostics, ...approvals.diagnostics);
  const currentStage = transitions.receipts.at(-1)?.to ?? flow.stages[0]?.id ?? 'unknown';
  const transitionHead = transitions.receipts.at(-1)?.digest ?? null;
  const revision = await computeGovernanceRevision(project, changeId, flow, state, resources, currentStage, transitionHead);
  /*
   * One read of the Change's audit facts, which resolve from the committed
   * `evidence/audit/index.json` when the gitignored local chain is absent (fresh clone, CI).
   */
  const auditFacts = await readChangeAuditEvents(project, changeId);
  /* Separation of duties needs Git history; only pay for it when a selected policy asks for it. */
  let implementers: ReadonlySet<string> | null = null;
  const needsImplementers = (flow.governance?.approvalPolicies ?? []).some((policy) => policy.separationOfDuties);
  const binding = async (): Promise<ApprovalBinding> => {
    if (needsImplementers && implementers === null) implementers = await changeImplementers(project, changeId, state);
    return { governingRevision: revision.governingRevision!, stateRevision: revision.stateRevision, implementers: implementers ?? undefined };
  };
  const currentIndex = flow.stages.findIndex((stage) => stage.id === currentStage);
  const current = currentIndex >= 0 ? flow.stages[currentIndex]! : null;
  const candidates = current ? legalTransitionTargets(flow, current.id) : [];
  const transitionRequirements = new Map<string, { approvals: ApprovalReceipt[]; gates: GateEvidence[]; blockedBy: string[] }>();
  const readyTransitions: GovernanceState['readyTransitions'] = [];
  const pendingApprovals: GovernanceState['pendingApprovals'] = [];

  for (const target of candidates) {
    const blockedBy: string[] = [];
    const approvalEvidence: ApprovalReceipt[] = [];
    const gateEvidence: GateEvidence[] = [];
    const isRework = currentIndex >= 0 && target !== 'ready-to-archive' && flow.stages.findIndex((stage) => stage.id === target) <= currentIndex;
    /* Outside the `isRework` guard on purpose: a forked or broken receipt chain makes the Change's
       current Stage itself unreliable, so rework is no more decidable than forward progress. This
       is the targeted block that replaces the whole-Change error the chain check used to raise. */
    if (!transitions.chainValid) blockedBy.push('transition-chain:invalid');
    if (!isRework && current) {
      for (const artifactId of current.produces) {
        if (state.artifacts.find((artifact) => artifact.id === artifactId)?.status !== 'done') blockedBy.push(`artifact:${artifactId}`);
      }
      if (current.id === 'apply' && target === 'verify' && state.workPackages) {
        for (const workPackage of state.workPackages.packages) if (!['succeeded', 'integrated', 'reviewed'].includes(workPackage.status)) blockedBy.push(`work-package:${workPackage.id}:${workPackage.status}`);
      }
      const exit = structuredExit(current);
      for (const gateId of [...new Set([...(current.gates ?? []), ...(exit.gates ?? [])])]) {
        const evidence = await readGateEvidence(project, changeId, gateId, resources);
        /* Gate Evidence is bound to content, not to Stage/transition state or to gitHead. */
        const reason = gateBlockReason(evidence, revision.contentRevision);
        if (reason) blockedBy.push(`gate:${gateId}:${reason}`);
        else gateEvidence.push(evidence!);
      }
      /* Conditions are evaluated after the Gates, not before: the verification-receipt ledger is
         decided against the Gate Evidence this Stage actually produced, so that set has to exist. */
      for (const [key, expected] of Object.entries(exit.conditions ?? {})) {
        const condition = key === VERIFICATION_RECEIPT_CONDITION
          ? await evaluateVerificationReceiptCondition(project, changeId, expected, revision.contentRevision, gateEvidence)
          : await evaluateExitCondition(project, changeId, key, expected, identities);
        if (!condition.satisfied) blockedBy.push(`condition:${key}:${condition.reason}`);
      }
      for (const policyId of exit.approvals ?? []) {
        const policy = policyById(flow, policyId);
        if (!policy) { blockedBy.push(`approval-policy:${policyId}:missing`); continue; }
        const result = approvalsForPolicy(approvals.receipts, policy, target, await binding());
        approvalEvidence.push(...result.valid);
        if (result.rejected) blockedBy.push(`approval:${policyId}:rejected`);
        if (!result.separationSatisfied) blockedBy.push(`approval:${policyId}:separation-of-duties`);
        if (result.missing > 0) {
          blockedBy.push(`approval:${policyId}:missing-${result.missing}`);
        }
        if (result.missing > 0 || !result.separationSatisfied) {
          pendingApprovals.push({ policyId, transition: target, missing: result.missing, roles: policy.roles, providers: providerKinds(project, policy) });
        }
      }
      for (const eventType of exit.auditEvents ?? []) if (!auditFacts.eventTypes.includes(eventType)) blockedBy.push(`audit:${eventType}:missing`);
      if (!auditFacts.chain.valid) blockedBy.push('audit:chain-invalid');
    }
    transitionRequirements.set(target, { approvals: approvalEvidence, gates: gateEvidence, blockedBy });
    readyTransitions.push({ to: target, ready: blockedBy.length === 0, blockedBy });
  }

  if (currentStage === 'ready-to-archive') {
    for (const policyId of flow.terminal.archive.approvals ?? []) {
      const policy = policyById(flow, policyId);
      if (!policy) continue;
      const result = approvalsForPolicy(approvals.receipts, policy, 'archive', await binding());
      if (result.missing > 0 || result.rejected || !result.separationSatisfied) pendingApprovals.push({ policyId, transition: 'archive', missing: result.missing, roles: policy.roles, providers: providerKinds(project, policy) });
    }
  }

  const rules = [...resources.rules.values()].map((item) => normalizeRule(item.value)).filter((rule) => ruleApplies(rule, config, currentStage)).map((rule) => {
    const coverage: GovernanceState['rules'][number]['coverage'] = ['instructed'];
    if (rule.policyRefs.some((id) => resources.policies.has(id))) coverage.push('guarded');
    const verified = rule.gateRefs.some((id) => transitionRequirements.get(candidates[0] ?? '')?.gates.some((gate) => gate.gate === id));
    if (verified) coverage.push('verified');
    const approved = rule.approvalRefs.some((id) => approvals.receipts.some((receipt) => receipt.policyId === id && receipt.decision === 'approve'
      && boundToRevision(receipt, { governingRevision: revision.governingRevision!, stateRevision: revision.stateRevision })));
    if (approved) coverage.push('approved');
    if (rule.severity === 'must' && rule.gateRefs.length === 0 && rule.approvalRefs.length === 0) coverage.push('uncovered');
    return { id: rule.id, severity: rule.severity, instruction: rule.instruction, coverage, gateRefs: rule.gateRefs, policyRefs: rule.policyRefs, approvalRefs: rule.approvalRefs };
  });

  const governance: GovernanceState = {
    currentStage, transitionHead, transitions: transitions.receipts, revision,
    pendingApprovals: pendingApprovals.filter((item, index, all) => index === all.findIndex((candidate) => candidate.policyId === item.policyId && candidate.transition === item.transition)),
    approvals: approvals.receipts,
    rules,
    policies: [...resources.policies.values()].map((item) => ({ id: item.value.metadata.name, capability: item.value.spec.capability, effect: item.value.spec.effect, applicable: policyApplies(item.value, config, currentStage) })),
    hooks: [...resources.hooks.values()].map((item) => ({ id: item.value.metadata.name, plane: item.value.spec.plane ?? 'legacy', event: item.value.spec.event, selected: true, enabled: item.value.spec.enabled })),
    audit: { chainValid: auditFacts.chain.valid, chainHead: auditFacts.chain.head, eventCount: auditFacts.eventCount, remotePending: auditFacts.delivery.pending, coverageGaps: auditFacts.coverageGaps },
    readyTransitions,
  };
  return { governance, diagnostics, flow, state, transitionRequirements, resources, auditFacts, transitionChainValid: transitions.chainValid };
}

/**
 * Why a Gate blocks, as one of three distinct states — or `null` when it does not block.
 *
 * These used to collapse into a single `missing-or-stale`, which reads as a filing problem even
 * when the Gate ran and genuinely failed. That mattered once a remedy was attached to the string:
 * a Change held up by a real Gate failure was told to re-run `check`, which cannot help and points
 * away from the finding the Gate reported.
 */
export function gateBlockReason(evidence: GateEvidence | null | undefined, contentRevision: string): 'missing' | 'failed' | 'stale' | null {
  if (!evidence) return 'missing';
  if (evidence.status !== 'passed') return 'failed';
  if (evidence.contentRevision !== contentRevision) return 'stale';
  return null;
}

/**
 * The way out of a block, spelled out, for the blocks where naming a command is the whole fix.
 *
 * Gate Evidence binds to the content revision at the moment the Gate runs, so an Agent that runs
 * one Gate, edits an Artifact, then runs the next has silently invalidated the first — every Gate
 * reports `passed` and the Stage still will not close. Naming the remedy turns that dead end into
 * one command. Only `stale` earns it: `failed` needs the finding fixed, and `missing` needs the
 * Gate run for the first time, neither of which this sentence describes.
 *
 * `work-package:<id>:ready` earns one for the same reason, found the same way — a live run of the
 * Solid Flow stopped dead at apply -> verify because the Change carried a work-package plan nobody
 * had dispatched. The plan's mere existence is what `resolveControlPlane` blocks on; no Flow field
 * declares a Stage work-package-driven, so an Agent that authors a plan at Design and then works
 * the packages itself hits a block whose only clue was the word "ready".
 */
export function blockRemedy(blocks: readonly string[], changeId: string): { code: string; message: string } | null {
  if (blocks.some((block) => /^gate:.+:stale$/.test(block))) {
    /* Plain `check` runs the current Stage's whole Gate set. `--all-gates` would also run Gates
       belonging to Stages the Change has not reached, which cannot pass yet and is not the advice. */
    return {
      code: 'XFORGE_GATE_EVIDENCE_STALE_REMEDY',
      message: `Gate Evidence is bound to the content revision, so editing any Artifact after a Gate ran makes that Gate stale. Run \`xforge check --change ${changeId}\` after your last write to re-run this Stage's Gates against the current content.`,
    };
  }

  const undispatched = blocks.flatMap((block) => /^work-package:(.+):ready$/.exec(block)?.[1] ?? []);
  if (undispatched.length > 0) {
    const packages = undispatched.map((id) => `\`xforge work-package dispatch --change ${changeId} --package ${id}\``).join(', ');
    return {
      code: 'XFORGE_WORK_PACKAGE_UNDISPATCHED_REMEDY',
      message: `Apply cannot close while a package in this Change's work-package plan has never been dispatched. Dispatch each one, have its Worker record a delivery, then run \`xforge check --change ${changeId}\` to bind the deliveries: ${packages}.`,
    };
  }

  /* Every later status — dispatched, in-progress, failed — is waiting on the Worker's delivery or
     on a fix to it, which is work, not a command this sentence could name. */
  return null;
}

export async function terminalGovernanceBlocks(
  project: ProjectContext,
  control: ResolvedControlPlane,
  options: { auditFacts?: ChangeAuditFacts } = {},
): Promise<string[]> {
  const { governance, flow } = control;
  const blocks: string[] = [];
  /* The counterpart of the per-transition block in `resolveControlPlane`. Archive reads the same
     receipt chain to decide which Stage's Gates it must re-check, so a chain that does not resolve
     to one history cannot close a Change either — the chain-invalid diagnostic is a warning now,
     and this is what stops it from becoming a silent pass. */
  if (!control.transitionChainValid) blocks.push('transition-chain:invalid');
  if (governance.currentStage !== 'ready-to-archive') blocks.push('transition:ready-to-archive');
  const readyReceipt = governance.transitions.at(-1);
  if (!readyReceipt || readyReceipt.to !== 'ready-to-archive') {
    blocks.push('transition:ready-receipt-missing');
  } else {
    /* gitHead is audit metadata: a commit that changes no governed content is not staleness. */
    if (readyReceipt.contentRevision !== governance.revision.contentRevision || readyReceipt.policySnapshotDigest !== governance.revision.policySnapshotDigest) {
      blocks.push('transition:ready-receipt-stale');
    }
    const sourceStage = flow.stages.find((stage) => stage.id === readyReceipt.from);
    const sourceExit = sourceStage ? structuredExit(sourceStage) : {};
    const sourceGates: GateEvidence[] = [];
    for (const gateId of [...new Set([...(sourceStage?.gates ?? []), ...(sourceExit.gates ?? [])])]) {
      const evidence = await readGateEvidence(project, control.state.id, gateId, control.resources);
      const boundToTransition = Boolean(evidence && readyReceipt.gates.includes(evidence.digest) && evidence.stateRevision === readyReceipt.stateRevisionBefore);
      const boundToArchiveRecheck = Boolean(evidence && evidence.contentRevision === governance.revision.contentRevision);
      /* Archive accepts Evidence bound either to the closing transition or to a re-check at the
         current revision, so staleness here is its own rule — but missing and failed are not. */
      if (!evidence) blocks.push(`gate:${gateId}:missing`);
      else if (evidence.status !== 'passed') blocks.push(`gate:${gateId}:failed`);
      else if ((!boundToTransition && !boundToArchiveRecheck) || evidence.policySnapshotDigest !== governance.revision.policySnapshotDigest) {
        blocks.push(`gate:${gateId}:stale`);
      } else sourceGates.push(evidence);
    }
    /* Archive re-decides the closing Stage's Gates rather than trusting the receipt's word for them;
       the verification receipt is Evidence of the same kind and is re-decided here for the same
       reason. Only the Flow that declares the condition pays for it. */
    const expectedReceipt = sourceExit.conditions?.[VERIFICATION_RECEIPT_CONDITION];
    if (expectedReceipt !== undefined) {
      const verification = await evaluateVerificationReceiptCondition(
        project, control.state.id, expectedReceipt, governance.revision.contentRevision, sourceGates,
      );
      if (!verification.satisfied) blocks.push(`condition:${VERIFICATION_RECEIPT_CONDITION}:${verification.reason}`);
    }
  }
  let implementers: ReadonlySet<string> | null = null;
  for (const policyId of flow.terminal.archive.approvals ?? []) {
    const policy = policyById(flow, policyId);
    if (!policy) { blocks.push(`approval-policy:${policyId}:missing`); continue; }
    if (policy.separationOfDuties && implementers === null) implementers = await changeImplementers(project, control.state.id, control.state);
    const result = approvalsForPolicy(governance.approvals, policy, 'archive', {
      governingRevision: governance.revision.governingRevision!, stateRevision: governance.revision.stateRevision, implementers: implementers ?? undefined,
    });
    if (result.rejected) blocks.push(`approval:${policyId}:rejected`);
    if (!result.separationSatisfied) blocks.push(`approval:${policyId}:separation-of-duties`);
    if (result.missing > 0) blocks.push(`approval:${policyId}:missing-${result.missing}`);
  }
  const policy = flow.terminal.archive.auditPolicy ?? flow.governance?.audit;
  const remoteRequired = policy?.remoteDelivery === 'required' || Boolean(project.manifest.audit?.remote?.requiredFor.includes(flow.policy.assuranceLevel));
  /*
   * Archive is decided from the Change's own committed audit index when the gitignored local chain
   * is missing, so a fresh clone or a CI runner can close a Change the laptop that ran it started.
   */
  const facts = options.auditFacts ?? control.auditFacts ?? await readChangeAuditEvents(project, control.state.id);
  for (const type of policy?.requiredEventTypes ?? []) if (!facts.eventTypes.includes(type)) blocks.push(`audit:${type}:missing`);
  if (!facts.chain.valid) blocks.push('audit:chain-invalid');
  if (!facts.trusted) blocks.push('audit:untrusted');
  if (policy?.runtimeCoverage === 'required' && facts.coverageGaps.length > 0) blocks.push('audit:runtime-coverage-gap');
  if (remoteRequired && facts.delivery.pending > 0) blocks.push('audit:remote-pending');
  if (remoteRequired && !project.manifest.audit?.remote) blocks.push('audit:remote-not-configured');
  return [...new Set(blocks)];
}
