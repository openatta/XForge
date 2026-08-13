import { readFile } from 'node:fs/promises';
import type { Diagnostic, FileChange, Flow, GateEvidence, GateResource, ProjectContext, StageFlow } from '../types.js';
import { checkStructure } from '../core/checker.js';
import { diagnostic } from '../core/errors.js';
import { assertManaged } from '../core/project-loader.js';
import { workPackageVerificationGates } from '../core/work-packages.js';
import { runGate } from '../runners/gate.js';
import { readAuditEvents, recordAudit } from '../core/audit.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadTransitionReceipts, resolveControlPlane } from '../core/control-plane.js';
import { sha256, stableStringify } from '../core/hash.js';
import { safeResolve } from '../core/path-safety.js';
import type { SelectedResources } from '../core/resource-loader.js';

/** Stages that run before any implementation exists, so no work-package verify can be meaningful. */
const PRE_APPLY_STAGES = new Set(['propose', 'clarify', 'design', 'check']);

export interface CheckOptions {
  change?: string;
  /**
   * A single Gate ID, or one of the overrides `all` (every Gate the Flow can ever require) and
   * `stage:<id>` (that Stage's Gates). The overrides only apply when no Gate carries that name.
   */
  gate?: string;
  /** Run every Gate the Flow can require, regardless of the current Stage. Archive uses this. */
  allGates?: boolean;
  /** Resolve Gates for this Stage instead of the Change's current Stage. */
  stage?: string;
  /** Bypass reuse of passed, still-current work-package verify Evidence; always re-run every verify Gate. */
  force?: boolean;
}

export type GateSelection = 'none' | 'explicit' | 'stage' | 'all' | 'archive';

export interface CheckData {
  structure: { passed: boolean };
  change: string | null;
  /** The Stage whose Gates were selected, or null when selection did not come from a Stage. */
  stage: string | null;
  gateSelection: GateSelection;
  workPackages: Array<{ packageId: string; command: string; status: 'passed' | 'failed'; evidence: GateEvidence; cached: boolean }>;
  gates: Array<{ id: string; status: 'passed' | 'failed'; evidence: GateEvidence | null }>;
}

const ALL_GATES = 'all';
const STAGE_PREFIX = 'stage:';

function flowGateIds(flow: StageFlow): string[] {
  return [...new Set(flow.stages.flatMap((stage) => [...(stage.gates ?? []), ...(stage.exit?.gates ?? [])]))];
}

function stageGateIds(flow: StageFlow, stageId: string): string[] | null {
  const stage = flow.stages.find((candidate) => candidate.id === stageId);
  return stage ? [...new Set([...(stage.gates ?? []), ...(stage.exit?.gates ?? [])])] : null;
}

/**
 * Mirrors the `revision` derivation `runGate` performs internally (gate.ts, `export async function
 * runGate`) so `inputDigest` can be predicted here without running the Gate. Returns `null` on any
 * failure to resolve state/control-plane so the caller falls back to actually running the Gate.
 */
async function computeGateInputDigest(
  project: ProjectContext,
  changeId: string,
  gate: GateResource,
  structurePassed: boolean,
  resources: SelectedResources,
): Promise<string | null> {
  try {
    const resolved = await resolveChangeState(project, changeId);
    const control = isStageFlow(resolved.flow) && resolved.flow.governance
      ? await resolveControlPlane(project, changeId, resolved.flow, resolved.state, resources, resolved.config)
      : null;
    const revision = control?.governance.revision ?? {
      contentRevision: sha256(stableStringify({ changeId, flow: resolved.flow.metadata.name })),
      stateRevision: sha256(stableStringify({ changeId, flow: resolved.flow.metadata.name, stage: 'legacy' })),
      policySnapshotDigest: sha256(stableStringify({ legacy: true })), gitBase: 'unknown', gitHead: 'unknown',
    };
    return sha256(stableStringify({ gate, revision, structurePassed }));
  } catch {
    return null;
  }
}

/**
 * Reuses passed Evidence already on disk for `gate` when its `inputDigest` matches what this run
 * would produce, so `check` does not re-run a Gate whose outcome could not have changed. Mirrors the
 * evidence self-consistency check in gate.ts's own evidence-conflict-detection code (`gate`/`change`
 * fields and digest recomputation), then additionally requires the `inputDigest` to match and the
 * cached `status` to be `'passed'`. Any mismatch, missing file, or parse failure returns `null` so
 * the caller falls back to running the Gate for real; a caching bug must never silently skip a Gate.
 *
 * Reads the (cheap) evidence file *before* computing the (expensive — a full `resolveChangeState` +
 * `resolveControlPlane`) expected digest: the common case for a work package that has never been
 * verified yet is "no evidence file exists," and probing the control plane before even checking that
 * would otherwise double the control-plane resolution cost of every cache-miss `check` call (`runGate`
 * resolves it again internally) — on a CI runner with less headroom than a developer machine, that
 * regression is exactly what pushed several unrelated, pre-existing tests over their timeout.
 */
async function readReusableGateEvidence(
  project: ProjectContext,
  changeId: string,
  gate: GateResource,
  resources: SelectedResources,
): Promise<GateEvidence | null> {
  const evidencePath = `${project.changesPath}/${changeId}/evidence/${gate.spec.evidence}`;
  let existing: GateEvidence;
  try {
    const existingSource = await readFile(await safeResolve(project.root, evidencePath), 'utf8');
    existing = JSON.parse(existingSource) as GateEvidence;
  } catch {
    return null;
  }
  const { digest: existingDigest, ...existingUnsigned } = existing;
  if (existing.gate !== gate.metadata.name || existing.change !== changeId || existingDigest !== sha256(stableStringify(existingUnsigned))) return null;
  if (existing.status !== 'passed') return null;
  const expectedInputDigest = await computeGateInputDigest(project, changeId, gate, true, resources);
  if (!expectedInputDigest || existing.inputDigest !== expectedInputDigest) return null;
  return existing;
}

export async function executeCheck(project: ProjectContext, options: CheckOptions): Promise<{
  data: CheckData;
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'check');
  const structure = await checkStructure(project, options.change);
  const diagnostics = [...structure.diagnostics];
  const staleLockCodes = new Set(['XFORGE_LOCK_SCAFFOLD_MISMATCH', 'XFORGE_LOCK_PATHS_MISMATCH', 'XFORGE_LOCK_RESOURCES_MISMATCH']);
  if (diagnostics.some((item) => staleLockCodes.has(item.code))) {
    diagnostics.push(diagnostic('XFORGE_LOCK_STALE', 'Run xforge install to resolve and lock current Manifest paths, Scaffold, and resources before check.', 'xforge/lock.yaml'));
  }
  const changes: FileChange[] = [];
  const hasStructureErrors = diagnostics.some((item) => item.severity === 'error');
  const gateResults: CheckData['gates'] = [];
  const workPackageResults: CheckData['workPackages'] = [];

  /*
   * Gate selection is owned by the Flow's Stages, not by a fixed archive-time set. `xforge-propose`
   * runs `check --change <id>` while still in propose; running the verify Stage's Gates there costs
   * a full test suite and a security scan whose Evidence the next file edit invalidates anyway.
   * Overrides: `--gate <id>`, `--gate all` / allGates, `--gate stage:<id>` / stage.
   */
  let gateIds: string[] = [];
  let gateSelection: GateSelection = 'none';
  let selectedStage: string | null = null;
  const gateOption = options.gate && structure.resources.gates.has(options.gate) ? options.gate : undefined;
  const sentinel = options.gate && !gateOption ? options.gate : undefined;
  const wantsAllGates = options.allGates === true || sentinel === ALL_GATES;
  const wantsStage = options.stage ?? (sentinel?.startsWith(STAGE_PREFIX) ? sentinel.slice(STAGE_PREFIX.length) : undefined);

  if (gateOption) {
    gateIds = [gateOption];
    gateSelection = 'explicit';
  } else if (sentinel && !wantsAllGates && !wantsStage) {
    /* An unknown Gate ID must still be reported, exactly as before. */
    gateIds = [sentinel];
    gateSelection = 'explicit';
  } else if (options.change && structure.change) {
    const archiveGates = structure.change.archive.mandatoryGates;
    let flow: Flow | null = null;
    try { flow = (await resolveChangeState(project, options.change)).flow; } catch { flow = null; }
    if (flow && isStageFlow(flow)) {
      if (wantsAllGates) {
        gateIds = [...new Set([...flowGateIds(flow), ...archiveGates])];
        gateSelection = 'all';
      } else {
        const transitions = await loadTransitionReceipts(project, options.change, flow);
        selectedStage = wantsStage ?? transitions.receipts.at(-1)?.to ?? flow.stages[0]?.id ?? null;
        const stageGates = selectedStage ? stageGateIds(flow, selectedStage) : null;
        if (stageGates) {
          gateIds = stageGates;
          gateSelection = 'stage';
        } else {
          /* ready-to-archive and any Stage the Flow does not declare fall back to the archive set. */
          if (wantsStage && wantsStage !== 'ready-to-archive') diagnostics.push(diagnostic(
            'XFORGE_CHECK_STAGE_UNKNOWN',
            `Flow ${flow.metadata.name} does not declare Stage ${wantsStage}; falling back to the archive Gate set.`,
            `xforge/flows/${flow.metadata.name}.yaml`, 'warning',
          ));
          gateIds = archiveGates;
          gateSelection = 'archive';
        }
      }
    } else {
      gateIds = archiveGates;
      gateSelection = 'archive';
    }
  } else if (!options.change && (wantsAllGates || wantsStage)) {
    gateSelection = wantsAllGates ? 'all' : 'stage';
    diagnostics.push(diagnostic('XFORGE_CHANGE_REQUIRED', 'A Change is required to resolve Stage Gates and save Evidence.'));
  }

  if (gateIds.length > 0 && !options.change) {
    const external = gateIds.some((id) => structure.resources.gates.get(id)?.value.spec.builtin !== 'structure');
    if (external) diagnostics.push(diagnostic('XFORGE_CHANGE_REQUIRED', 'A Change is required to run a Gate and save Evidence.'));
  }

  /* Work packages are Apply-stage assets: their `verify` commands exercise code that does not exist
     until implementation starts. Running them from an earlier Stage's check would fail a Change for
     work it has not been asked to do yet. `null` covers legacy Flows and whole-Flow overrides. */
  const workPackagesInScope = selectedStage === null || !PRE_APPLY_STAGES.has(selectedStage);
  if (!hasStructureErrors && !options.gate && options.change && workPackagesInScope && structure.change?.workPackages) {
    for (const verification of workPackageVerificationGates(structure.change.workPackages)) {
      const reused = options.force ? null : await readReusableGateEvidence(project, options.change, verification.gate, structure.resources);
      if (reused) {
        workPackageResults.push({
          packageId: verification.packageId,
          command: verification.command,
          status: reused.status,
          evidence: reused,
          cached: true,
        });
        continue;
      }
      const result = await runGate(project, options.change, verification.gate, true);
      changes.push(result.change);
      if (result.evidence.status === 'failed') diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_VERIFY_FAILED',
        `Work package ${verification.packageId} verification failed: ${verification.command}`,
        result.change.path,
        'error',
        { exitCode: result.evidence.exitCode, timedOut: result.evidence.timedOut },
      ));
      workPackageResults.push({
        packageId: verification.packageId,
        command: verification.command,
        status: result.evidence.status,
        evidence: result.evidence,
        cached: false,
      });
    }
  }

  if (!hasStructureErrors && (!gateIds.length || options.change || gateIds.every((id) => structure.resources.gates.get(id)?.value.spec.builtin === 'structure'))) {
    for (const id of gateIds) {
      const resource = structure.resources.gates.get(id);
      if (!resource) {
        diagnostics.push(diagnostic('XFORGE_GATE_NOT_FOUND', `Selected Gate does not exist or is not enabled: ${id}`, 'xforge/manifest.yaml'));
        gateResults.push({ id, status: 'failed', evidence: null });
        continue;
      }
      if (!options.change) {
        gateResults.push({ id, status: 'passed', evidence: null });
        continue;
      }
      const result = await runGate(project, options.change, resource.value, true);
      changes.push(result.change);
      if (result.diagnostic) diagnostics.push(result.diagnostic);
      gateResults.push({ id, status: result.evidence.status, evidence: result.evidence });
    }
  }

  if (options.change && structure.change?.workPackages && !diagnostics.some((item) => item.severity === 'error')) {
    const resolved = await resolveChangeState(project, options.change);
    if (isStageFlow(resolved.flow) && resolved.flow.governance) {
      resolved.state.workPackages = structure.change.workPackages;
      const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, structure.resources, resolved.config);
      const existing = await readAuditEvents(project);
      for (const item of structure.change.workPackages.packages.filter((candidate) => ['succeeded', 'integrated', 'reviewed'].includes(candidate.status) && candidate.delivery)) {
        const delivery = item.delivery!;
        for (const eventType of ['work-package.delivered']) {
          const inputDigest = sha256(stableStringify({ eventType, delivery }));
          if (existing.some((event) => event.eventType === eventType && event.inputDigest === inputDigest)) continue;
          await recordAudit(project, {
            eventType, change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage,
            workPackage: item.id, correlationId: delivery.audit_correlation_id, revision: control.governance.revision,
            outcome: 'succeeded', inputDigest, input: null,
          });
        }
      }
    }
  }

  return {
    data: {
      structure: { passed: !hasStructureErrors }, change: options.change ?? null,
      stage: gateSelection === 'stage' ? selectedStage : null, gateSelection,
      workPackages: workPackageResults, gates: gateResults,
    },
    diagnostics,
    changes,
  };
}
