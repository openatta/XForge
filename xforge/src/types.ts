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
  command?: string[];
}

export interface Envelope<T = unknown> {
  protocolVersion: '1';
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

export interface GitScaffoldSource {
  type: 'git';
  repository: string;
  commit: string;
}

export interface HttpScaffoldSource {
  type: 'http';
  url: string;
  sha256: string;
}

export interface NpmCliSource {
  source: 'npm';
  package: string;
  version: string;
  protocol: '1';
}

export interface GitCliSource {
  source: 'git';
  repository: string;
  commit: string;
  path: 'xforge';
  protocol: '1';
}

export interface Manifest {
  apiVersion: 'xforge.dev/v1alpha1';
  kind: 'Project';
  metadata: Metadata;
  project: {
    layout: 'single' | 'monorepo';
    paths?: { specs?: string; changes?: string };
    modules: ProjectModule[];
  };
  scaffold: {
    version: string;
    source: GitScaffoldSource | HttpScaffoldSource;
    skills: string[];
    agents: string[];
    rules: string[];
    hooks: string[];
    gates: string[];
  };
  scripts?: string[];
  xforge: NpmCliSource | GitCliSource;
  flow: string;
  targets: TargetId[];
  install: {
    conflictPolicy: 'fail';
    prune: 'managed-only';
    commitGeneratedFiles: boolean;
  };
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
  exit?: Record<string, string>;
  execution?: {
    planning: 'just-in-time';
    workPackages: 'internal' | 'adaptive' | 'required';
  };
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
  stages: FlowStage[];
  terminal: {
    archive: {
      handler: string;
      authority: 'archive-write';
      requires: string[];
      syncSpecs: boolean;
      evidencePolicy: 'current-revision';
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
}

export interface WorkPackageState extends WorkPackage {
  status: 'ready' | 'blocked' | 'succeeded' | 'failed';
  missingDependencies: string[];
  delivery: WorkPackageDelivery | null;
}

export interface WorkPackagePlanState {
  path: string;
  baseCommit: string | null;
  ready: string[];
  protectedWritePaths: string[];
  packages: WorkPackageState[];
}

export interface ArtifactState extends ArtifactDefinition {
  status: 'done' | 'ready' | 'blocked';
  outputPaths: string[];
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
    level: 'mandatory' | 'advisory' | 'scoped';
    instruction: string;
    modules?: string[];
    paths?: string[];
    gate?: string;
    writePolicy?: 'integrator-only';
    constitutionCompatibility?: 'compatible' | 'conflict';
  };
}

export interface HookResource {
  apiVersion: string;
  kind: 'Hook';
  metadata: Metadata;
  spec: Record<string, unknown> & { enabled: false };
}

export interface GateResource {
  apiVersion: string;
  kind: 'Gate';
  metadata: Metadata;
  spec: {
    stage: 'check' | 'before-archive';
    required: boolean;
    builtin?: 'structure';
    command?: string[];
    shell?: boolean;
    workingDirectory?: string;
    timeoutSeconds: number;
    maxOutputBytes?: number;
    evidence: string;
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
  protocolVersion: '1';
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
}

export interface DesiredFile {
  path: string;
  content: Buffer;
  source: string;
  target: TargetId;
  resource: { kind: string; id: string };
  sourcePaths: string[];
  renderVersion: string;
}

export interface GateEvidence {
  protocolVersion: '1';
  gate: string;
  change: string;
  command: string[] | ['builtin:structure'];
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
