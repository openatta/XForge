import type { Diagnostic } from './protocol.js';
import type { Metadata } from './resource.js';
import type { TargetId } from '../constants.js';
import type { ScaffoldLanguage } from './protocol.js';
import type { AgentResource, GateResource, HookResource, McpServerResource, PermissionPolicyResource, RuleResource, ScriptResource } from './resource.js';

/**
 * The project as declared, and as loaded.
 *
 * `Manifest` is what the repository says about itself, `Lockfile` is what was resolved from it, and
 * `ProjectContext` is the pair after loading, which is what nearly every function here takes as its
 * first argument.
 */


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
    /**
     * Which Flows this project runs, and therefore which ones an upgrade may propose changes to.
     *
     * Optional because every project initialised before Flows joined the managed set has no such
     * list, and a Flow it never declared is one the upgrade reports as unselected rather than one
     * it silently starts maintaining.
     */
    flows?: string[];
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

/**
 * Which of the two shapes a verification entry is.
 *
 * A declaration either says how a Gate runs or says which toolchain it deliberately does not cover,
 * and every reader has to branch on that before touching either field.
 */
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
