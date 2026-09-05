import type { Metadata } from './resource.js';

/**
 * The Flow graph: Artifacts, Stages, and the two Flow shapes that have existed.
 *
 * `LegacyFlow` and `StageFlow` are a union rather than a version field because the two are read by
 * different code paths -- `isStageFlow` narrows, and Protocol 1 projects still load.
 */

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
  validator?: 'spec-delta' | 'contract-delta' | 'outline';
  markers?: ArtifactMarker[];
  /**
   * When this Artifact is owed at all; absent means always.
   *
   * Exists because a contract delta is the first Artifact a Change can legitimately owe nothing of.
   * Every other one is owed by every Change on the Flow, and an empty glob is therefore an
   * unfinished Stage -- but a Change that moves no interface has nothing to declare, and holding
   * its Stage open until it writes a document saying so is friction with no reader.
   *
   * It reads the Change's self-declared `classification`, and the CLI does not pretend otherwise: nothing
   * here catches a Change that moves an interface while declaring it did not. `contract-compat` is
   * what does, and it is dialect-specific, so it is selected rather than shipped on.
   */
  requiredWhen?: { anyImpact?: Array<'security' | 'privacy' | 'publicApi' | 'dataMigration' | 'moduleContract'> };
}

export interface LegacyFlow {
  apiVersion: 'xforge.dev/v1alpha1';
  kind: 'Flow';
  metadata: Metadata & { version: string | number; description: string };
  artifacts: ArtifactDefinition[];
  operations: {
    apply: { requires: string[]; tracks: string };
    archive: { requires: string[]; syncSpecs: boolean; syncContracts?: boolean; mandatoryGates: string[] };
  };
}

export type FlowAuthority = 'read-only' | 'planning-write' | 'assurance-write' | 'implementation-write' | 'archive-write';

export interface StageFlowArtifact extends Omit<ArtifactDefinition, 'requires'> {}

export type ExitCondition = string | { expected: string; requiredWhen: { anyImpact?: Array<'security' | 'privacy' | 'publicApi' | 'dataMigration' | 'moduleContract'> } };

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
    /**
     * Condition key -> the status its ledger must declare.
     *
     * The object form narrows *which Changes owe it*, in the same `requiredWhen` shape the
     * Artifacts use. A Change that does not match owes no ledger and is not blocked by its absence
     * — written that way rather than as a ledger every Change files empty, because an `entries: []`
     * nobody could skip is a turn spent asserting nothing and a Stage held open until it is spent.
     */
    conditions?: Record<string, ExitCondition>;
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
      contractImpact?: 'forbidden' | 'allowed';
      maxModules?: number;
    };
    requiredWhen?: {
      risk?: Array<'low' | 'medium' | 'high'>;
      anyImpact?: Array<'security' | 'privacy' | 'publicApi' | 'dataMigration' | 'moduleContract'>;
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
      /**
       * Gates archive re-runs before it closes the Change.
       *
       * v1alpha1 required this as `mandatoryGates`; v1alpha2 dropped it and inferred the set from
       * the Stage literally named `verify`. That inference is invisible when it is wrong: a Flow
       * with a Stage after Verify contributes none of its Gates to the archive check, and nothing
       * says so. Optional, and absent still falls back to Verify's Gates, so every Flow written
       * against v1alpha2 keeps its current behaviour.
       */
      gates?: string[];
      syncContracts?: boolean;
      /** Accepted for compatibility with Flows written before it was removed; nothing reads it. */
      evidencePolicy?: 'current-revision';
      approvals?: string[];
      auditPolicy?: FlowAuditPolicy;
    };
  };
}

export type Flow = LegacyFlow | StageFlow;
