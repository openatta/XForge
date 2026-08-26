import type { TargetId } from '../constants.js';

/**
 * What was projected into a target, and what a target can accept.
 *
 * Ownership records exist so `uninstall` and `sync` can tell a file this product wrote from a file
 * somebody edited afterwards; the two state versions are both live, because a project installed
 * before the change still has the older one on disk.
 */

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
