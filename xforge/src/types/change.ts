import type { ArtifactDefinition } from './flow.js';
import type { GovernanceState } from './governance.js';
import type { WorkPackagePlanState } from './work-package.js';

/**
 * A Change as configured and as resolved.
 *
 * `ChangeConfig` is `change.yaml`; `ChangeState` is that plus everything the resolvers computed from
 * it, which is what `xforge state` reports and what most governance decisions read.
 */

export interface ChangeConfig {
  flow: string;
  classification: {
    risk: 'low' | 'medium' | 'high';
    security: boolean;
    privacy: boolean;
    publicApi: boolean;
    dataMigration: boolean;
    /* Optional, so a change.yaml written before contracts existed still satisfies this type. */
    moduleContract?: boolean;
  };
  scope: { modules: string[]; paths: string[] };
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
  archive: { ready: boolean; requires: string[]; mandatoryGates: string[]; syncSpecs: boolean; syncContracts: boolean };
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
