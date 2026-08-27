import type { ApprovalPolicy } from './flow.js';

/**
 * The records that decide whether a Change may move.
 *
 * Every one of these is evidence rather than opinion: a Gate's own output, a revision computed from
 * content, a receipt signed for a specific revision. `GovernanceState` is the resolved reading of
 * all of them at one moment.
 */

export interface GateEvidence {
  protocolVersion: '2';
  schemaVersion: '1';
  gate: string;
  change: string;
  flow: string;
  stage: string;
  stateRevision: string;
  contentRevision: string;
  policySnapshotDigest: string;
  gitBase: string;
  gitHead: string;
  inputDigest: string;
  runner: { name: string; version: string; integrity: string };
  command: string[] | ['builtin:structure'] | ['builtin:check-findings'] | ['builtin:constitution-check'];
  shell: boolean;
  workingDirectory: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  stdout: string;
  stderr: string;
  status: 'passed' | 'failed';
  digest: string;
}

export interface GovernanceRevision {
  contentRevision: string;
  stateRevision: string;
  policySnapshotDigest: string;
  gitBase: string;
  gitHead: string;
  /**
   * Governance-only binding for Approvals: `change.yaml`, the Flow, the policy snapshot, and the
   * Artifacts produced up to and including the current Stage. Excludes `gitHead` and later Stages'
   * Evidence, so a commit or a downstream Artifact write does not invalidate a human decision.
   */
  governingRevision?: string;
}

export interface ApprovalReceipt {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'ApprovalReceipt';
  receiptId: string;
  change: string;
  flow: string;
  stage: string;
  transition: string;
  policyId: string;
  stateRevision: string;
  contentRevision: string;
  policySnapshotDigest: string;
  gitBase: string;
  gitHead: string;
  governingDigest: string;
  decision: 'approve' | 'reject';
  approver: { id: string; provider: string; role: string; type: 'human' | 'external-system' };
  decidedAt: string;
  reason: string;
  expiresAt?: string;
  externalRef?: string;
  digest: string;
  /** Governance binding of the approved Stage; absent on receipts issued before the split. */
  governingRevision?: string;
  /**
   * How a local human decision was obtained. Only the CLI's own terminal dialogue can set this;
   * it can never be supplied on the command line. Absent on provider-issued receipts. There is no
   * typed code here: the receipt is trusted because the project's own audit hash chain independently
   * recorded the `approval.decided` event that produced it (see `approvalVerifiedInChain`), not
   * because of anything carried on the receipt itself.
   */
  attestation?: {
    method: 'cli-terminal';
    respondedAt: string;
  };
}

export interface TransitionReceipt {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'TransitionReceipt';
  receiptId: string;
  sequence: number;
  change: string;
  flow: string;
  from: string;
  to: string;
  contentRevision: string;
  stateRevisionBefore: string;
  policySnapshotDigest: string;
  gitHead: string;
  previousReceiptDigest: string | null;
  transitionedAt: string;
  actor: { id: string; provider: string; type: 'human' | 'agent' | 'system' };
  approvals: string[];
  gates: string[];
  auditHead: string | null;
  digest: string;
}

export interface RuleCoverage {
  id: string;
  severity: 'must' | 'should';
  instruction: string;
  /**
   * `unenforceable` is not a weaker `uncovered`; it is a different statement. `uncovered` says the
   * Rule cites no mechanism. `unenforceable` says it cites one that does not exist under the Flow
   * this Change is running — a Gate the project does not have, or an approval policy only another
   * Flow defines. Before the distinction existed, the second case read as covered, because a
   * non-empty `approvalRefs` was taken as proof that something was enforcing the Rule: a `must` Rule
   * pointing at `planning-solid` reported as governed under `major`, where no such policy exists and
   * nothing was checking it at all.
   */
  coverage: Array<'instructed' | 'guarded' | 'verified' | 'approved' | 'uncovered' | 'unenforceable'>;
  gateRefs: string[];
  policyRefs: string[];
  approvalRefs: string[];
  /** The subset of `gateRefs`/`approvalRefs` that names something this Flow and project actually have. */
  enforceableRefs: string[];
}

export interface GovernanceState {
  currentStage: string;
  transitionHead: string | null;
  transitions: TransitionReceipt[];
  revision: GovernanceRevision;
  pendingApprovals: Array<{ policyId: string; transition: string; missing: number; roles: string[]; providers: Array<{ id: string; type: 'local' | 'mcp' }> }>;
  approvals: ApprovalReceipt[];
  rules: RuleCoverage[];
  policies: Array<{ id: string; capability: string; effect: string; applicable: boolean }>;
  hooks: Array<{ id: string; plane: string; event: string; selected: boolean; enabled: boolean }>;
  audit: {
    chainValid: boolean;
    chainHead: string | null;
    eventCount: number;
    remotePending: number;
    /**
     * Whether anything actually requires those pending events to reach a remote sink.
     *
     * `remotePending` alone is a number whose meaning lives in a policy the reader cannot see from
     * where it is printed. The shipped default is `remoteDelivery: optional` with an empty
     * `audit.remote.requiredFor`, so the ordinary case is a large pending count that means nothing —
     * and a reader who cannot tell that from the output has to choose between chasing a non-problem
     * and ignoring a real one. `audit verify` resolves this already; carrying it here lets every
     * other reader of governance state say the same thing.
     */
    remoteRequired: boolean;
    coverageGaps: string[];
  };
  readyTransitions: Array<{ to: string; ready: boolean; blockedBy: string[] }>;
}

export interface AuditEvent {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'AuditEvent';
  eventId: string;
  eventType: string;
  timestamp: string;
  plane: 'workflow' | 'runtime';
  platform: string;
  surface: 'local' | 'cloud' | 'ci' | 'unknown';
  sessionId: string;
  turnId: string;
  toolCallId: string;
  correlationId: string;
  actor: { id: string; provider: string; role: string; type: 'human' | 'agent' | 'system' | 'external-system' };
  change: string | null;
  flow: string | null;
  stage: string | null;
  workPackage: string | null;
  stateRevision: string;
  gitBase: string;
  gitHead: string;
  refs: { rules: string[]; policies: string[]; gates: string[] };
  decision: string | null;
  reason: string | null;
  outcome: 'succeeded' | 'failed' | 'denied' | 'spooled' | 'unknown';
  durationMs: number | null;
  inputDigest: string;
  outputDigest: string;
  redaction: 'metadata-only' | 'strict' | 'balanced';
  coverage: { observed: boolean; gaps: string[] };
  previousHash: string | null;
  deliveryState: 'not-configured' | 'pending' | 'spooled' | 'delivered';
  hash: string;
  /** Present only when `manifest.audit.chain.hmacSecretEnv` is declared. See `core/audit.ts`. */
  hmac?: string;
}
