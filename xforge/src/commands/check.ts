import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, FileChange, Flow, GateEvidence, GateResource, NextAction, ProjectContext, StageFlow } from '../types.js';
import { checkStructure } from '../core/checker.js';
import { diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { assertManaged } from '../core/project-loader.js';
import { workPackageVerificationGates } from '../core/work-packages.js';
import { gateInputDigest, runGate } from '../runners/gate.js';
import { readAuditEvents, recordAudit } from '../core/audit.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadTransitionReceipts, resolveControlPlane } from '../core/control-plane.js';
import { sha256, stableStringify } from '../core/hash.js';
import { safeResolve } from '../core/path-safety.js';

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
  /**
   * `evidencePath` is carried because a Gate's Evidence file is not named after the Gate —
   * `unit-tests` writes `tests.json`, `security-scan` writes `security.json` — and a verification
   * receipt has to cite each Gate's digest. Without it the only way to find the file was to list
   * the Evidence directory and guess which entry belonged to which Gate.
   */
  gates: Array<{ id: string; status: 'passed' | 'failed'; evidence: GateEvidence | null; evidencePath: string | null }>;
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
 * Local, machine-scoped reuse keys for work-package verify Evidence.
 *
 * Deliberately under the gitignored `xforge/.audit/` tree rather than beside the Evidence: a key
 * records the state of *uncommitted* edits on one machine at one moment. It is a cache, never a
 * governance artifact, so it must not be committed, reviewed, or trusted from another clone — a
 * missing key simply means the Gate runs again.
 */
const AUDIT_DIRECTORY = 'xforge/.audit';
const GATE_REUSE_DIRECTORY = `${AUDIT_DIRECTORY}/gate-reuse`;
/** Bounds on the uncommitted state a reuse key will hash; beyond them the Gate re-runs instead. */
const MAX_DIRTY_ENTRIES = 5_000;
const MAX_DIRTY_BYTES = 64 * 1024 * 1024;

interface GateReuseRecord {
  schemaVersion: '1';
  change: string;
  gate: string;
  evidencePath: string;
  /** The Evidence file these keys describe; a re-run under a different tree invalidates the pair. */
  evidenceDigest: string;
  worktreeDigest: string;
}

function gateReuseRecordPath(changeId: string, gate: GateResource): string {
  return `${GATE_REUSE_DIRECTORY}/${changeId}/${gate.metadata.name.replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`;
}

/** `git` stdout, or `null` on any failure — including output past the byte bound. */
async function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-C', root, ...args], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= MAX_DIRTY_BYTES) chunks.push(chunk);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && bytes <= MAX_DIRTY_BYTES ? Buffer.concat(chunks).toString('utf8') : null));
  });
}

/**
 * A digest of everything the working tree holds that `HEAD` does not: every modified, staged,
 * deleted, and untracked (but not ignored) path, with its current content.
 *
 * This is the half of "what could change a verify command's outcome" that `inputDigest` structurally
 * cannot see. `inputDigest` binds the Gate definition, the governance Artifacts, the policy
 * snapshot, and `gitBase`/`gitHead` — so a *commit* already invalidates it. Uncommitted edits move
 * none of those inputs, which is precisely the state an Agent implementing a Change is in for most
 * of its run. Pairing the two covers the whole tree: `HEAD` by commit id, the delta from `HEAD` by
 * content.
 *
 * Two prefixes are excluded, both for the same reason — `check` writes them itself on every run, so
 * including them would invalidate the key the moment it was created: the Change's own directory
 * (Evidence and the audit index; the governance inputs that live there are already bound by
 * `inputDigest` through the Change's content revision) and `xforge/.audit/` (the local audit chain
 * and these reuse keys, which are normally gitignored but need not be in every project).
 *
 * Returns `null` — meaning "re-run the Gate" — whenever the tree cannot be established exactly:
 * no Git, a failed `git` invocation, a project root that is not the worktree root (porcelain paths
 * are relative to the repository root, so they would not resolve), an unreadable dirty path, or
 * more dirty state than the bounds above allow. Reuse must never be the fallback for not knowing.
 */
async function workingTreeDigest(project: ProjectContext, changeId: string): Promise<string | null> {
  const toplevel = await git(project.root, ['rev-parse', '--show-toplevel']);
  if (toplevel === null) return null;
  const [resolvedToplevel, resolvedRoot] = await Promise.all([
    realpath(toplevel.trim()).catch(() => ''),
    realpath(project.root).catch(() => path.resolve(project.root)),
  ]);
  if (!resolvedToplevel || resolvedToplevel !== resolvedRoot) return null;
  const status = await git(project.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (status === null) return null;

  const excluded = [`${project.changesPath}/${changeId}/`, `${AUDIT_DIRECTORY}/`];
  const entries: Array<{ status: string; path: string; digest: string }> = [];
  let bytes = 0;
  for (const record of status.split('\0')) {
    if (record.length < 4) continue;
    const relative = record.slice(3);
    if (excluded.some((prefix) => relative.startsWith(prefix))) continue;
    if (entries.length >= MAX_DIRTY_ENTRIES) return null;
    let digest = 'absent';
    try {
      const content = await readFile(await safeResolve(project.root, relative));
      bytes += content.byteLength;
      if (bytes > MAX_DIRTY_BYTES) return null;
      digest = sha256(content);
    } catch (error) {
      /* A deleted path has nothing left to hash. Anything else unreadable is unknown state. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    entries.push({ status: record.slice(0, 2), path: relative, digest });
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return sha256(stableStringify(entries));
}

/**
 * Passed Evidence on disk that this run may reuse instead of executing the Gate again.
 *
 * Reuse requires all of: the Evidence is self-consistent and belongs to this Gate and Change (the
 * same check gate.ts performs before overwriting Evidence), its `status` is `passed`, its
 * `inputDigest` matches what a run right now would record, and a reuse key written by the run that
 * produced this exact Evidence still matches the current working tree.
 *
 * The last condition is not redundant. `inputDigest` proves only that the Gate definition, the
 * governance Artifacts, the policy snapshot, and `HEAD` are unchanged — it says nothing about
 * uncommitted edits, so on its own it would let an Agent edit source, re-run `check`, and be told
 * its verify passed without the command ever executing.
 *
 * Any mismatch, missing file, or parse failure returns `null` and the Gate runs for real; a caching
 * bug must never silently skip a Gate.
 *
 * Order matters: the two cheap file reads come before the expensive `gateInputDigest` (a full
 * `resolveChangeState` + `resolveControlPlane`). The common case for a work package that has never
 * been verified is "no Evidence file exists," and probing the control plane before establishing that
 * would double the control-plane cost of every cache-miss `check` (`runGate` resolves it again
 * internally) — on a CI runner with less headroom than a developer machine, that regression is
 * exactly what pushed several unrelated, pre-existing tests over their timeout.
 */
async function readReusableGateEvidence(
  project: ProjectContext,
  changeId: string,
  gate: GateResource,
  worktreeDigest: string | null,
): Promise<GateEvidence | null> {
  if (!worktreeDigest) return null;
  const evidencePath = `${project.changesPath}/${changeId}/evidence/${gate.spec.evidence}`;
  let existing: GateEvidence;
  try {
    const existingSource = await readFile(await safeResolve(project.root, evidencePath), 'utf8');
    existing = JSON.parse(existingSource) as GateEvidence;
  } catch {
    return null;
  }
  const { digest: existingDigest, ...existingUnsigned } = existing;
  if (existing.gate !== gate.metadata.name || existing.change !== changeId) return null;
  if (existing.status !== 'passed') return null;
  if (existingDigest !== sha256(stableStringify(existingUnsigned))) return null;
  let record: GateReuseRecord;
  try {
    record = JSON.parse(await readFile(await safeResolve(project.root, gateReuseRecordPath(changeId, gate)), 'utf8')) as GateReuseRecord;
  } catch {
    return null;
  }
  if (record.change !== changeId || record.gate !== gate.metadata.name || record.evidencePath !== evidencePath) return null;
  if (record.evidenceDigest !== existingDigest || record.worktreeDigest !== worktreeDigest) return null;
  let expectedInputDigest: string;
  try {
    expectedInputDigest = await gateInputDigest(project, changeId, gate, true);
  } catch {
    return null;
  }
  return existing.inputDigest === expectedInputDigest ? existing : null;
}

/**
 * Records the working tree the Gate just ran against, so a later `check` can tell "nothing moved"
 * from "nothing I can see moved". Best effort: a failure here only costs the next run a re-run.
 */
async function writeGateReuseRecord(
  project: ProjectContext,
  changeId: string,
  gate: GateResource,
  evidence: GateEvidence,
  worktreeDigest: string | null,
): Promise<void> {
  if (!worktreeDigest || evidence.status !== 'passed') return;
  const record: GateReuseRecord = {
    schemaVersion: '1',
    change: changeId,
    gate: gate.metadata.name,
    evidencePath: `${project.changesPath}/${changeId}/evidence/${gate.spec.evidence}`,
    evidenceDigest: evidence.digest,
    worktreeDigest,
  };
  try {
    await atomicWrite(project.root, gateReuseRecordPath(changeId, gate), `${JSON.stringify(record, null, 2)}\n`);
  } catch { /* A missing reuse key is a cache miss, never a wrong result. */ }
}

export async function executeCheck(project: ProjectContext, options: CheckOptions): Promise<{
  data: CheckData;
  diagnostics: Diagnostic[];
  changes: FileChange[];
  nextActions: NextAction[];
}> {
  assertManaged(project, 'check');
  const structure = await checkStructure(project, options.change);
  const diagnostics = [...structure.diagnostics];
  const nextActions: NextAction[] = [];
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
    const verifications = workPackageVerificationGates(structure.change.workPackages);
    /* One working-tree read for the whole run: the verify commands dominate `check`, and a verify
       that mutates the tree only costs itself the next run's reuse, which is the safe direction. */
    const worktreeDigest = verifications.length > 0 ? await workingTreeDigest(project, options.change) : null;
    for (const verification of verifications) {
      const reused = options.force ? null : await readReusableGateEvidence(project, options.change, verification.gate, worktreeDigest);
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
      await writeGateReuseRecord(project, options.change, verification.gate, result.evidence, worktreeDigest);
      if (result.evidence.status === 'failed') diagnostics.push(
        /*
         * `runGate` already decided whether the command ran at all — it distinguishes ENOENT,
         * EACCES and exit 127 from a real failure and says so in `result.diagnostic`. This branch
         * used to throw that away and report every outcome as "verification failed", so a project
         * whose `cargo` was not on PATH read fifteen failing test suites that had never started.
         * A missing tool and a failing test need different actions from the reader; both still
         * block, so nothing is loosened by telling them apart.
         */
        result.diagnostic?.code === 'XFORGE_GATE_COMMAND_UNAVAILABLE'
          ? diagnostic(
            'XFORGE_WORK_PACKAGE_VERIFY_UNRUNNABLE',
            `Work package ${verification.packageId} verification could not be executed: ${verification.command}. ${result.diagnostic.message}`,
            result.change.path,
            'error',
            { ...(result.diagnostic.details as Record<string, unknown> ?? {}), packageId: verification.packageId },
          )
          : diagnostic(
            'XFORGE_WORK_PACKAGE_VERIFY_FAILED',
            `Work package ${verification.packageId} verification failed: ${verification.command}`,
            result.change.path,
            'error',
            { exitCode: result.evidence.exitCode, timedOut: result.evidence.timedOut },
          ),
      );
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
        gateResults.push({ id, status: 'failed', evidence: null, evidencePath: null });
        continue;
      }
      if (!options.change) {
        gateResults.push({ id, status: 'passed', evidence: null, evidencePath: null });
        continue;
      }
      const result = await runGate(project, options.change, resource.value, true);
      changes.push(result.change);
      if (result.diagnostic) diagnostics.push(result.diagnostic);
      /* A Gate refusing for want of a human answer carries the question with it; dropping it here
         would leave the diagnostic naming a problem with no route to the fix. */
      nextActions.push(...result.nextActions);
      gateResults.push({ id, status: result.evidence.status, evidence: result.evidence, evidencePath: result.change.path });
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

  /*
   * A passing Gate must not be readable as "nothing to see here".
   *
   * The `structure` Gate passes on errors alone, correctly: its warnings are advisory and promoting
   * them would fail Changes that were valid before the rule that warns existed. But its stdout is
   * the flat sentence "Structural validation passed.", and a live XOps run read that as the whole
   * result — the Artifact marker warning sitting in the same envelope went unread at Propose and at
   * Verify, and surfaced at `archive --dry-run`, after the transition and after a human approval.
   * The check had in fact reported it at the producing Stage every time. Nobody saw it.
   *
   * So this says out loud what the Gate's own output cannot: the Gate passed, and the run still
   * found things. Deliberately an `info` at the command level, never part of Gate Evidence —
   * `gateInputDigest` is `sha256({gate, revision, structurePassed})`, so touching what
   * `structurePassed` means would rewrite every Evidence digest in every project to say something
   * no Gate's verdict actually changed.
   */
  const advisories = diagnostics.filter((item) => item.severity === 'warning');
  /*
   * Only when the run is otherwise green, and only for a Change.
   *
   * `some(passed)` was wrong twice over: a run with one passing and three failing Gates asserted
   * "Gates passed", and a `--gate` selection without `--change` never executes a Gate at all — it
   * pushes `passed` unrun — so the sentence vouched for Gates that had not run. Neither case is the
   * one this notice is for. A failing Gate is already a loud result; nothing is being masked, and
   * adding a cheerful line to a failure is worse than saying nothing.
   */
  const gatesAllPassed = gateResults.length > 0 && gateResults.every((item) => item.status === 'passed');
  if (advisories.length > 0 && gatesAllPassed && options.change && !diagnostics.some((item) => item.severity === 'error')) {
    const codes = [...new Set(advisories.map((item) => item.code))].sort();
    /* The archive clause is claimed only where it is true. Artifact content is what archive
       re-decides; a stale lock or an unknown module is reported by other commands, on other
       schedules, and promising this one would be a guess dressed as a schedule. */
    const artifactAdvisory = advisories.some((item) => item.code.startsWith('XFORGE_ARTIFACT_'));
    const tail = artifactAdvisory
      ? ' They are advisory now and cost nothing to fix here; an Artifact problem left unfixed is next reported by archive, after the Stage has transitioned and after anyone has approved it.'
      : ' They are advisory now and cost nothing to fix here.';
    diagnostics.push(diagnostic(
      'XFORGE_CHECK_PASSED_WITH_WARNINGS',
      `Every Gate in this run passed, and the same run reported ${advisories.length} warning${advisories.length === 1 ? '' : 's'}: ${codes.join(', ')}. A passing Gate is not a clean check.${tail}`,
      `${project.changesPath}/${options.change}`,
      'info',
    ));
  }

  return {
    data: {
      structure: { passed: !hasStructureErrors }, change: options.change ?? null,
      stage: gateSelection === 'stage' ? selectedStage : null, gateSelection,
      workPackages: workPackageResults, gates: gateResults,
    },
    diagnostics,
    changes,
    nextActions,
  };
}
