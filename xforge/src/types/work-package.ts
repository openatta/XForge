/**
 * The work-package plan, its executions, and the receipts they produce.
 *
 * Kept together because a delivery, its dispatch receipt and its acknowledgement are one story told
 * in three files on disk, and reading any of them without the others is how a caller ends up
 * trusting a claim nobody signed.
 */

export interface WorkPackage {
  id: string;
  /**
   * `worker` (the default) or `integrator`.
   *
   * The distinction exists because integration was the one piece of real work the DAG could not see.
   * `integrator_paths` gave the assembly surface a unique writer, which fixed attribution, but a set
   * of paths is not a node: with every worker package `succeeded` the control plane reported the
   * Apply transition ready while nothing had been assembled yet, and every Gate agreed, because
   * nothing in the plan claimed the assembly was owed. An integrator package is that claim.
   *
   * A plan may carry more than one, provided they are ordered with respect to each other — the
   * bootstrap a Change needs before any worker can build is integration too, and it happens first.
   * What is refused is two that could run at the same time; see
   * `XFORGE_WORK_PACKAGE_INTEGRATOR_CONCURRENT`.
   */
  role?: 'worker' | 'integrator';
  goal: string;
  depends_on: string[];
  inputs: string[];
  write_paths: string[];
  skills: string[];
  /**
   * Each entry is an argv array run without a shell. A bare string is the deprecated pre-argv form:
   * it is accepted for one version when it contains no shell metacharacters and rejected outright
   * when it does, because a string that reaches `sh -c` lets a work-package plan — a file the Change
   * owns and the lockfile does not cover — compose arbitrary commands. See `core/work-packages.ts`.
   */
  verify: Array<string[] | string>;
  done_when: string[];
}

export interface WorkPackagePlan {
  apiVersion: 'xforge.dev/v1alpha1';
  kind: 'WorkPackagePlan';
  packages: WorkPackage[];
  /**
   * Paths this plan reserves for the Integrator: shared contracts, module lists, DI roots, config
   * assembly points — what joins the packages together and therefore belongs to none of them.
   *
   * Without it, a file created during integration is attributable to nobody and invalidates every
   * delivery in the plan, and the only workaround is to file it under a package that did not
   * produce it.
   */
  integrator_paths?: string[];
}

export interface WorkPackageDelivery {
  execution_id: string;
  recorded_at: string;
  status: 'succeeded' | 'blocked' | 'failed';
  package_id: string;
  base_commit: string;
  head_commit: string | null;
  changed_paths: string[];
  validation: Array<{ command: string; exit_code: number | null }>;
  issues: string[];
  done_when_evidence?: Array<{ criterion: string; evidence: string[] }>;
  state_revision?: string;
  policy_snapshot_digest?: string;
  audit_correlation_id?: string;
}

export interface WorkPackageDispatchReceipt {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'WorkPackageDispatchReceipt';
  change: string;
  packageId: string;
  executionId: string;
  stateRevision: string;
  policySnapshotDigest: string;
  gitBase: string;
  gitHead: string;
  auditCorrelationId: string;
  issuedAt: string;
  digest: string;
}

export interface WorkPackageState extends WorkPackage {
  status: 'ready' | 'blocked' | 'running' | 'succeeded' | 'failed' | 'integrated' | 'reviewed';
  missingDependencies: string[];
  /**
   * The execution this package is currently on, from its latest dispatch receipt; `null` before it
   * has ever been dispatched.
   *
   * Carried because the dispatch receipt, the delivery record and the acknowledgement receipt are
   * all filed under `execution_id`, and the fourth artifact of an execution — the Evidence its
   * declared `verify` produces — had no way to reach it. `status: 'running'` already told callers
   * that *a* dispatch exists; it could not say which.
   */
  executionId: string | null;
  delivery: WorkPackageDelivery | null;
  /**
   * Who acknowledged this delivery, in each role. Reported so an approver can see whether the
   * semantic review was done by the same actor that produced the work — which the CLI can show but
   * cannot verify, since one session may name any actor.
   */
  acknowledgements: { reviewedBy: string | null; integratedBy: string | null };
}

export interface WorkPackagePlanState {
  path: string;
  baseCommit: string | null;
  ready: string[];
  waves: Array<{ index: number; packages: string[] }>;
  parallelCandidates: string[];
  protectedWritePaths: string[];
  /**
   * Paths changed after some delivery that no package declared and no Integrator-only path covers.
   *
   * A property of the tree and of the plan's declarations, not of any package — which is why it is
   * carried here rather than folded into a package's status. The control plane blocks the transition
   * on `tree:unattributed-paths` while this is non-empty.
   */
  unattributedPaths: string[];
  packages: WorkPackageState[];
}

export interface WorkPackageAckReceipt {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'WorkPackageAckReceipt';
  receiptId: string;
  change: string;
  packageId: string;
  executionId: string;
  as: 'reviewer' | 'integrator';
  status: 'reviewed' | 'integrated';
  /** Binds this ack to the specific delivery content acknowledged, so it cannot be replayed against a different delivery. */
  deliveryDigest: string;
  /** What this acknowledgement covered, verbatim from the acknowledger. Absent means nobody said. */
  scope?: string;
  actor: { id: string; provider: string; role: string; type: 'human' | 'agent' | 'system' };
  acknowledgedAt: string;
  digest: string;
}
