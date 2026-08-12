import type { TargetId } from './constants.js';

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  details?: unknown;
}

export interface FileChange {
  action: 'create' | 'modify' | 'delete' | 'move' | 'skip' | 'conflict';
  path: string;
  from?: string;
  digest?: string;
  source?: string;
  target?: TargetId;
  reason?: string;
}

export interface NextAction {
  action: string;
  reason: string;
  type?: 'artifact' | 'transition' | 'approval' | 'gate' | 'archive' | 'governance' | 'maintenance';
  id?: string;
  status?: 'ready' | 'blocked' | 'pending';
  blockedBy?: string[];
  command?: string[];
  actor?: 'main' | 'worker' | 'integrator' | 'reviewer' | 'human' | 'system';
  authority?: FlowAuthority;
  inputs?: string[];
  writes?: string[];
  doneWhen?: string[];
  requiredEvidence?: string[];
  reworkTo?: string[];
}

export type ScaffoldLanguage = 'en' | 'zh-CN';

export interface Envelope<T = unknown> {
  protocolVersion: '2';
  ok: boolean;
  command: string;
  root: string | null;
  data: T | null;
  diagnostics: Diagnostic[];
  changes: FileChange[];
  nextActions: NextAction[];
}

export interface Metadata {
  name: string;
  version?: string | number;
  description?: string;
}

export interface ProjectModule {
  id: string;
  path: string;
  kind: 'application' | 'service' | 'library' | 'module';
}

export interface NpmScaffoldSource {
  type: 'npm';
  package: '@xforge/cli';
  version: string;
}

export interface NpmCliSource {
  source: 'npm';
  package: '@xforge/cli';
  version: string;
  protocol: '1' | '2';
}

export interface Manifest {
  apiVersion: 'xforge.dev/v1alpha1' | 'xforge.dev/v1alpha2';
  kind: 'Project';
  metadata: Metadata;
  project: {
    layout: 'single' | 'monorepo';
    paths?: { specs?: string; changes?: string };
    modules: ProjectModule[];
  };
  scaffold: {
    version: string;
    source: NpmScaffoldSource;
    language: ScaffoldLanguage;
    skills: string[];
    agents: string[];
    rules: string[];
    policies?: string[];
    hooks: string[];
    gates: string[];
    mcpServers?: string[];
  };
  scripts?: string[];
  xforge: NpmCliSource;
  flow: string;
  targets: TargetId[];
  install: {
    conflictPolicy: 'fail';
    prune: 'managed-only';
    commitGeneratedFiles: boolean;
  };
  /**
   * XForge supports exactly two approval mechanisms: the CLI's own interactive terminal (`local`,
   * always available, not listed here) and an external system reached over MCP. There is no
   * signed-file-import path — an external decision must come from a live `submit_approval_request`
   * / `poll_approval` round trip against a registered McpServer, never from a receipt file dropped
   * on disk.
   */
  approvals?: {
    providers: Array<{ id: string; type: 'mcp'; mcpServer: string; roles: string[] }>;
    local?: {
      requireTty?: boolean;
    };
  };
  audit?: {
    redaction: 'strict' | 'balanced';
    localRetentionDays: number;
    remote?: {
      endpointEnv: string;
      tokenEnv?: string;
      hmacSecretEnv?: string;
      timeoutSeconds: number;
      requiredFor: Array<'quick' | 'solid' | 'major'>;
    };
    /**
     * Per-plane remote delivery. Defaults to `inline` for the workflow plane and `spool` for the
     * runtime plane, so an agent tool call never blocks on an audit HTTP round-trip.
     */
    delivery?: { workflow?: 'inline' | 'spool'; runtime?: 'inline' | 'spool' };
    /** Opt in to actually truncating the local chain at `localRetentionDays`. Default false. */
    localRetentionEnforce?: boolean;
  };
  runtime?: {
    /** Decision applied by the hook dispatcher when a tool cannot be mapped to a capability.
     * `allow` means "no XForge opinion, defer to the platform". Default `ask`. */
    unknownToolPolicy?: 'allow' | 'ask' | 'deny';
  };
  /** Extra environment variable names Gate subprocesses may inherit, on top of the built-in allowlist. */
  gates?: { env?: { allow?: string[]; allowPrefixes?: string[] } };
}

export interface Lockfile {
  apiVersion?: string;
  kind?: string;
  protocol?: string;
  scaffold?: Record<string, unknown>;
  xforge?: Record<string, unknown>;
  paths?: { specs?: string; changes?: string };
  resources?: Array<Record<string, unknown>>;
  targets?: string[];
  generatedProtocol?: string;
}

export interface ArtifactDefinition {
  id: string;
  generates: string;
  description: string;
  instruction: string;
  outline: string;
  requires: string[];
  validator?: 'spec-delta';
}

export interface LegacyFlow {
  apiVersion: 'xforge.dev/v1alpha1';
  kind: 'Flow';
  metadata: Metadata & { version: string | number; description: string };
  artifacts: ArtifactDefinition[];
  operations: {
    apply: { requires: string[]; tracks: string };
    archive: { requires: string[]; syncSpecs: boolean; mandatoryGates: string[] };
  };
}

export type FlowAuthority = 'read-only' | 'planning-write' | 'assurance-write' | 'implementation-write' | 'archive-write';

export interface StageFlowArtifact extends Omit<ArtifactDefinition, 'requires'> {}

export interface FlowStage {
  id: string;
  skill: string;
  authority: FlowAuthority;
  requires: string[];
  produces: string[];
  revises?: string[];
  gates?: string[];
  reworkTo?: string[];
  exit?: {
    conditions?: Record<string, string>;
    gates?: string[];
    approvals?: string[];
    auditEvents?: string[];
  };
  execution?: {
    planning: 'just-in-time';
    workPackages: 'internal' | 'adaptive' | 'required';
  };
}

export interface ApprovalPolicy {
  id: string;
  minApprovers: number;
  roles: string[];
  separationOfDuties: boolean;
  providers: string[];
}

export interface FlowAuditPolicy {
  requiredEventTypes: string[];
  runtimeCoverage: 'optional' | 'required';
  remoteDelivery: 'optional' | 'required';
}

export interface StageFlow {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'Flow';
  metadata: Metadata & { version: string | number; description: string };
  policy: {
    assuranceLevel: 'quick' | 'solid' | 'major';
    eligibleWhen: {
      risk: Array<'low' | 'medium' | 'high'>;
      criticalImpacts: 'forbidden' | 'allowed';
      maxModules?: number;
    };
    requiredWhen?: {
      risk?: Array<'low' | 'medium' | 'high'>;
      anyImpact?: Array<'security' | 'privacy' | 'publicApi' | 'dataMigration'>;
    };
    onUncertain: 'escalate' | 'request-decision';
  };
  artifacts: StageFlowArtifact[];
  governance?: {
    approvalPolicies: ApprovalPolicy[];
    audit: FlowAuditPolicy;
  };
  stages: FlowStage[];
  terminal: {
    archive: {
      handler: string;
      authority: 'archive-write';
      requires: string[];
      syncSpecs: boolean;
      evidencePolicy: 'current-revision';
      approvals?: string[];
      auditPolicy?: FlowAuditPolicy;
    };
  };
}

export type Flow = LegacyFlow | StageFlow;

export interface ChangeConfig {
  flow: string;
  classification: {
    risk: 'low' | 'medium' | 'high';
    security: boolean;
    privacy: boolean;
    publicApi: boolean;
    dataMigration: boolean;
  };
  scope: { modules: string[]; paths: string[] };
}

export interface WorkPackage {
  id: string;
  goal: string;
  depends_on: string[];
  inputs: string[];
  write_paths: string[];
  skills: string[];
  verify: string[];
  done_when: string[];
}

export interface WorkPackagePlan {
  apiVersion: 'xforge.dev/v1alpha1';
  kind: 'WorkPackagePlan';
  packages: WorkPackage[];
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
  delivery: WorkPackageDelivery | null;
}

export interface WorkPackagePlanState {
  path: string;
  baseCommit: string | null;
  ready: string[];
  waves: Array<{ index: number; packages: string[] }>;
  parallelCandidates: string[];
  protectedWritePaths: string[];
  packages: WorkPackageState[];
}

export interface ArtifactState extends ArtifactDefinition {
  status: 'done' | 'ready' | 'blocked';
  /** Files that actually exist, relative to the Change directory. Empty until the Artifact is written. */
  outputPaths: string[];
  /**
   * Where this Artifact belongs, as a path from the project root. `generates` alone is relative to
   * the Change directory, and nothing said so: an Agent running the CLI from the project root read
   * `assurance.md` as a project-root file and wrote it there. The next-action `writes` field is
   * built from this, so the destination is stated rather than inferred.
   */
  writePath: string;
  missingDependencies: string[];
}

export interface ChangeState {
  id: string;
  path: string;
  flow: string;
  classification: ChangeConfig['classification'];
  scope: ChangeConfig['scope'];
  artifacts: ArtifactState[];
  nextArtifact: ArtifactState | null;
  apply: { ready: boolean; requires: string[]; tracks: string | null };
  archive: { ready: boolean; requires: string[]; mandatoryGates: string[]; syncSpecs: boolean };
  workPackages: WorkPackagePlanState | null;
  governance?: GovernanceState;
}

export interface AgentResource {
  apiVersion: string;
  kind: 'Agent';
  metadata: Metadata;
  spec: {
    role: string;
    instructions: string;
    skills: string[];
    tools: { allow: string[] };
    delegation: { callableBy: string[]; maxConcurrency: number };
    model: { class: string; fallback: string };
  };
}

export interface RuleResource {
  apiVersion: string;
  kind: 'Rule';
  metadata: Metadata;
  spec: {
    level?: 'mandatory' | 'advisory' | 'scoped';
    severity?: 'must' | 'should';
    instruction: string;
    modules?: string[];
    paths?: string[];
    gate?: string;
    writePolicy?: 'integrator-only';
    constitutionCompatibility?: 'compatible' | 'conflict';
    scope?: {
      modules?: string[];
      paths?: string[];
      stages?: string[];
    };
    enforcement?: {
      gateRefs: string[];
      policyRefs: string[];
      approvalRefs?: string[];
    };
  };
}

export interface PermissionPolicyResource {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'PermissionPolicy';
  metadata: Metadata;
  spec: {
    capability: 'fs.read' | 'fs.write' | 'shell' | 'network' | 'mcp' | 'subagent' | 'external.write';
    effect: 'deny' | 'ask' | 'allow';
    match: {
      paths?: string[];
      commands?: string[];
      tools?: string[];
      hosts?: string[];
      mcpServers?: string[];
      stages?: string[];
    };
    exceptActors?: string[];
    reason: string;
  };
}

export interface HookResource {
  apiVersion: string;
  kind: 'Hook';
  metadata: Metadata;
  spec: {
    enabled: boolean;
    plane?: 'runtime' | 'workflow';
    event: string;
    action?: { scriptRef?: string; builtin?: 'audit' | 'policy' };
    command?: string[];
    shell?: boolean;
    timeoutSeconds: number;
    workingDirectory?: string;
    permissions?: Array<'read' | 'write' | 'network'>;
    failurePolicy: 'deny' | 'ask' | 'stop' | 'spool' | 'warn';
    network?: boolean;
    matcher?: string;
  };
}

export interface GateResource {
  apiVersion: string;
  kind: 'Gate';
  metadata: Metadata;
  spec: {
    required: boolean;
    builtin?: 'structure' | 'check-findings' | 'constitution-check';
    command?: string[];
    shell?: boolean;
    workingDirectory?: string;
    timeoutSeconds: number;
    maxOutputBytes?: number;
    evidence: string;
    /**
     * Extra environment variable names this Gate's subprocess may inherit, on top of the built-in
     * allowlist and `Manifest.gates.env`. Names that look like credentials are always dropped.
     */
    env?: { allow?: string[]; allowPrefixes?: string[] };
  };
}

export interface ScriptResource {
  apiVersion: string;
  kind: 'Script';
  metadata: Metadata;
  spec: {
    runtime: 'node' | 'python';
    entry: string;
    arguments: string[];
    workingDirectory: string;
    timeoutSeconds: number;
    input: string;
    output: string;
    sideEffects: string;
  };
}

export interface McpServerResource {
  apiVersion: string;
  kind: 'McpServer';
  metadata: Metadata;
  spec: {
    transport: 'stdio' | 'http';
    command?: string[];
    cwd?: string;
    url?: string;
    authTokenEnv: string;
    timeoutSeconds: number;
  };
}

export interface Constitution {
  version: string;
  ratified: string;
  lastAmended: string;
  content: string;
  path: string;
}

export interface Compatibility {
  mode: 'managed' | 'portable';
  cli: { declared: string; actual: string; matches: boolean };
  protocol: { declared: string; actual: string; matches: boolean };
  scaffold: { declared: string; locked: string | null; matches: boolean | null };
}

export interface ProjectContext {
  root: string;
  manifestPath: string;
  manifest: Manifest;
  lockPath: string;
  lock: Lockfile | null;
  specsPath: string;
  changesPath: string;
  specsPathSource: 'default' | 'manifest';
  changesPathSource: 'default' | 'manifest';
  constitution: Constitution;
  compatibility: Compatibility;
  diagnostics: Diagnostic[];
}

export interface LegacyManagedFileRecord {
  source: string;
  target: TargetId;
  cliVersion: string;
  protocolVersion: string;
  digest: string;
  lastInstalledDigest: string;
}

export interface OwnershipStateV1 {
  version: 1;
  generatedAt: string;
  files: Record<string, LegacyManagedFileRecord>;
}

export interface SourceFingerprint {
  path: string;
  mtimeMs: number;
  size: number;
  digest: string;
}

export interface ManagedFileRecord {
  source: string;
  target: TargetId;
  resource: { kind: string; id: string };
  sources: SourceFingerprint[];
  renderVersion: string;
  cliVersion: string;
  protocolVersion: string;
  desiredDigest: string;
  lastInstalledDigest: string;
  /**
   * Present when XForge owns only part of the destination file (see `DesiredFile.fragment`).
   * Records the exact material XForge wrote, so `sync`/`update`/`uninstall` can touch that
   * material and nothing else. When absent the record has whole-file ownership.
   */
  fragment?: DesiredFile['fragment'];
}

export interface TargetInstallationState {
  adapterVersion: string;
  installedAt: string;
  lastUpdatedAt: string;
  lastSyncedAt: string | null;
  files: Record<string, ManagedFileRecord>;
}

export interface OwnershipStateV2 {
  version: 2;
  protocolVersion: '1' | '2';
  generatedAt: string;
  manifestSelectionDigest: string;
  manifestTargets: TargetId[];
  scaffoldIdentity: string;
  cliIdentity: string;
  targets: Partial<Record<TargetId, TargetInstallationState>>;
}

export type OwnershipState = OwnershipStateV1 | OwnershipStateV2;

export type CapabilityLevel = 'native' | 'degraded' | 'unsupported';

export interface AdapterCapability {
  skills: CapabilityLevel;
  commands: CapabilityLevel;
  agents: CapabilityLevel;
  rules: CapabilityLevel;
  hooks: CapabilityLevel;
  guidance: CapabilityLevel;
  permissionPolicy: CapabilityLevel;
  runtimeHook: {
    events: string[];
    blocking: CapabilityLevel;
    managed: CapabilityLevel;
    local: CapabilityLevel;
    cloud: CapabilityLevel;
    trust: 'platform-review' | 'managed' | 'none';
    bypasses: string[];
  };
  auditDelivery: CapabilityLevel;
  subagent: CapabilityLevel;
  /**
   * What the target's *static* permission layer can actually express. `permissionPolicy` above
   * only says whether such a layer exists; this says which PermissionPolicy dimensions survive
   * projection into it. Anything not covered here is enforced solely by the XForge PreToolUse
   * bridge, and `planProjection` emits a diagnostic saying so instead of dropping it silently.
   */
  permissionPolicyScopes?: {
    /** `spec.capability` values that become real static rules on this target. */
    capabilities: string[];
    /** Whether the static layer can honour `spec.exceptActors`. */
    actorScoped: boolean;
    /** Whether the static layer can honour `spec.match.stages`. */
    stageScoped: boolean;
  };
}

export interface DesiredFile {
  path: string;
  content: Buffer;
  source: string;
  target: TargetId;
  resource: { kind: string; id: string };
  sourcePaths: string[];
  renderVersion: string;
  /**
   * Declares that XForge owns only part of this destination instead of the whole file, so a
   * host-owned config file (`.claude/settings.json`, `CLAUDE.md`, `opencode.json`, ...) can be
   * shared. Everything outside the declared material is read in and written back untouched.
   *
   * - `json`   — owns individual array items and/or leaf values addressed by a key path.
   *              `seed` is applied only when the file does not exist yet and is never owned.
   * - `markers`— owns the text between `begin` and `end` marker lines.
   */
  fragment?:
    | {
      format: 'json';
      seed?: Record<string, unknown>;
      arrays?: Array<{ path: string[]; items: unknown[] }>;
      values?: Array<{ path: string[]; value: unknown }>;
    }
    | { format: 'markers'; begin: string; end: string; body: string };
}

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
  coverage: Array<'instructed' | 'guarded' | 'verified' | 'approved' | 'uncovered'>;
  gateRefs: string[];
  policyRefs: string[];
  approvalRefs: string[];
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
}
