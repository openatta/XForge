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
  /**
   * The `## ` headings this Artifact's Flow outline declares, verbatim.
   *
   * `outline` is a Markdown fragment in the Flow, and reads to an author as a suggested shape
   * rather than a literal one. A live run that was told nothing else wrote every required section
   * of two Artifacts and then, on the third, decorated two headings it wanted to qualify --
   * `## Completeness` became `## Completeness (at the current revision)`. The content was right and
   * the heading no longer resolved, which breaks anything keyed to it: markers, and the passages
   * `core/brief.ts` quotes into EXTRACTED.
   *
   * Stated here for the same reason `writes` is: the CLI knows the answer at the moment the author
   * needs it, and a fact the product can state is one no Skill has to carry.
   */
  requiredSections?: string[];
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
     * Opt-in HMAC over the local hash chain and the committed index. Absent (the default) leaves
     * the chain unkeyed, which detects corruption and accidental rewrites but not an actor who
     * rewrites the chain and its artifacts together — every input to the hash is public and lives
     * in the repository. Declaring a secret whose value comes from outside that repository is what
     * turns the chain from corruption-evident into tamper-evident.
     */
    chain?: { hmacSecretEnv?: string };
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
  /**
   * How this project runs each `builtin: declared` Gate, keyed by Gate name.
   *
   * XForge knows no programming languages, and this is where that stops being a limitation. The
   * shipped `unit-tests` Gate used to be `npm test` behind a guard that passed when no
   * `package.json` was present, so every Rust, Go or Python project got a Gate that reported
   * `passed` having asserted nothing — and, through it, a `must` Rule with no enforcement and an
   * archive whose mandatory Gate was empty. Teaching the CLI more languages only moves the edge of
   * that failure; declaring the command removes it, because an undeclared Gate refuses instead of
   * passing.
   */
  verification?: Record<string, VerificationEntry[]>;
}

/** One command that verifies part of this project, and who says so. */
export interface VerificationRun {
  command: string[];
  /** A `project.modules` id. Omitted means the whole project. */
  module?: string;
  /**
   * Detected build-system markers this run accounts for, as project-relative paths.
   *
   * Only needed once a repository has more than one toolchain, where "which of these does that
   * command cover" is a question with a real answer. Two markers can share a module root, so
   * `module` cannot express it.
   */
  covers?: string[];
  workingDirectory?: string;
  timeoutSeconds?: number;
  /**
   * The person attesting that this is how this project runs this check.
   *
   * Nothing can decide mechanically whether a command really verifies anything — `[echo, ok]` and
   * `[go, build, ./...]` both exit 0 without testing — so this records who answered rather than
   * pretending to check. It is the same move `decidedBy`, `approvedBy` and `resolvedBy` make in the
   * other ledgers.
   */
  declaredBy: string;
  declaredAt: string;
}

/** A detected toolchain a Gate deliberately does not cover, recorded so it is asked once. */
export interface VerificationDismissal {
  /** The detected marker file, project-relative. */
  notApplicable: string;
  justification: string;
  declaredBy: string;
  declaredAt: string;
}

export type VerificationEntry = VerificationRun | VerificationDismissal;

export function isVerificationRun(entry: VerificationEntry): entry is VerificationRun {
  return Array.isArray((entry as VerificationRun).command);
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

/**
 * A machine-locatable landmark inside an Artifact, declared by the Flow rather than inferred.
 *
 * `outline` already tells a reader which `## ` sections an Artifact must have, and that is enough
 * to slice one. It is not enough to answer questions *about* a section — "is every Requirement
 * named where this Flow says coverage is recorded", "which alternatives were rejected and why" —
 * because the answer depends on knowing what a section is *for*, and on the shape of the entries
 * inside it. Both were previously conventions an author happened to follow.
 *
 * Declaring them here is the difference between computing an answer and summarizing one. A rule
 * keyed on a marker either finds the marker or reports that the Flow never declared it; neither
 * outcome requires anybody to read prose and vouch for it. Markers are optional, and a rule that
 * depends on one simply does not run for a Flow that omits it — silence, never a guess.
 */
export interface ArtifactMarker {
  id: string;
  /** The exact `## ` heading text (without the `## `) this marker lives under. */
  section: string;
  /**
   * What the marked section or entry means:
   * - `requirement-coverage`: this section is where Requirement coverage is recorded.
   * - `decision-alternative`: entries matching `pattern` are rejected alternatives.
   * - `declared-gap`: entries matching `pattern` defer a question to a later Stage.
   */
  role: 'requirement-coverage' | 'decision-alternative' | 'declared-gap';
  /**
   * Literal prefixes, any one of which starts an entry. Omitted when the section as a whole is
   * the marker.
   *
   * A list rather than one string because a Flow is not localized but the prose inside an Artifact
   * is: the same Flow governs a project writing English and a project writing Chinese, so the
   * spelling of an entry marker has to be per-language while the Flow stays single-sourced.
   */
  pattern?: string[];
  /** Structural minimum the `structure` Gate enforces once the Artifact exists. */
  minOccurrences?: number;
}

export interface ArtifactDefinition {
  id: string;
  generates: string;
  description: string;
  instruction: string;
  outline: string;
  requires: string[];
  /**
   * How this Artifact is validated, when convention is not enough.
   *
   * `spec-delta` marks a delta Spec that does not live under `specs/`. `outline` opts the Artifact
   * into having its declared `outline` sections enforced rather than merely suggested -- see
   * `core/artifact-markers.ts`. The two are disjoint in practice: `outline` checks a single
   * free-form document, and every delta Spec writes a glob, which outline validation skips.
   */
  validator?: 'spec-delta' | 'outline';
  markers?: ArtifactMarker[];
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
    /** Accepted for compatibility with Flows written before it was removed; nothing reads it. */
    onUncertain?: 'escalate' | 'request-decision';
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
      /** Accepted for compatibility with Flows written before it was removed; nothing reads it. */
      evidencePolicy?: 'current-revision';
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
  /**
   * `worker` (the default) or the plan's single `integrator`.
   *
   * The distinction exists because integration was the one piece of real work the DAG could not see.
   * `integrator_paths` gave the assembly surface a unique writer, which fixed attribution, but a set
   * of paths is not a node: with every worker package `succeeded` the control plane reported the
   * Apply transition ready while nothing had been assembled yet, and every Gate agreed, because
   * nothing in the plan claimed the assembly was owed. An integrator package is that claim.
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
  /**
   * What each mandatory Gate's Evidence records as having run, so "it passed" and "it ran nothing"
   * are distinguishable without opening the Evidence JSON. Facts only; no verdict.
   */
  mandatoryGateEvidence?: Array<{
    gate: string;
    status: string | null;
    command: string[] | null;
    evidencePath: string | null;
    /**
     * Whether the Evidence is bound to the Change's current *content* revision -- its Artifacts,
     * its Flow, the policy snapshot. Named for what it compares. The old name, `currentRevision`,
     * read as "valid for the current state of things" and was taken that way: a Change re-entered
     * apply, merged two more work packages, returned to verify, and read three Gates as current
     * when the code they had exercised was two merges behind. Content and code move independently
     * and this field only ever spoke for one of them.
     */
    currentContentRevision: boolean | null;
    /**
     * The commit the Gate actually ran at, and how many source files have changed since.
     *
     * `null` when it cannot be established -- no Git, no recorded head, or a head that is not an
     * ancestor of the current one (a rebase, a shallow clone). Unknown is reported as unknown:
     * a count invented here would be read as a fact about the tree.
     *
     * Paths XForge writes itself are excluded, so committing the Evidence a Gate has just produced
     * does not read as the code having moved. That exclusion is why folding the commit into the
     * content revision was abandoned: it made every Gate stale the moment its own output was
     * committed. This measures the tree instead, and leaves the content revision alone.
     */
    gitHead: string | null;
    sourceFilesChangedSince: number | null;
  }>;
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
    /* Kept in step with gate.schema.json's enum, which has always accepted `declared`; the type
       omitted it, so every `builtin === 'declared'` test outside the runner failed to compile. */
    builtin?: 'structure' | 'check-findings' | 'constitution-check' | 'declared';
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
    /**
     * Extra environment variable names (`allow`) and name prefixes (`allowPrefixes`, e.g.
     * `CORP_APPROVALS_`) this MCP provider's `stdio` subprocess may inherit, on top of the built-in
     * allowlist (see core/env-safety.ts). Names that look like credentials are always dropped, even
     * if listed here or matched by a declared prefix.
     */
    env?: { allow?: string[]; allowPrefixes?: string[] };
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
  /**
   * Whether XForge can *write* Agent definitions this target understands — a fact about projection,
   * decided entirely by this process.
   *
   * `agents: native` above says the same for the file format. Neither says the runtime will offer
   * those Agents as selectable executors: XForge writes `.claude/agents/worker.md` and stops there,
   * and whether a session then exposes `worker` as a sub-agent type is the host's business and is
   * not observable from here. A live run had `agents: native`, `subagent: native`, a correct
   * `worker.md` on disk, and no `worker` in the runtime's list; the Worker contract had to be
   * inlined into a generic agent's prompt instead.
   *
   * Read this as "this target has a sub-agent mechanism and XForge has written the definitions for
   * it", never as "the contract in those definitions is being enforced by the runtime". It is not
   * enforced there in any case — a Worker's `write_paths` boundary is decided after the fact, by
   * `core/work-packages.ts` diffing `base...head` against the declared patterns, which is what
   * actually holds whether the runtime isolated anything or not.
   */
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
  actor: { id: string; provider: string; role: string; type: 'human' | 'agent' | 'system' };
  acknowledgedAt: string;
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
