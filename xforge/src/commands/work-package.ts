import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import type { Diagnostic, FileChange, ProjectContext, WorkPackageAckReceipt, WorkPackageDispatchReceipt } from '../types.js';
import { acknowledgementAttestationDigest, recordAudit } from '../core/audit.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { sha256, stableStringify } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { git, latestDispatchFor, resolveWorkPackages, workPackageVerificationGates } from '../core/work-packages.js';
import { runVerifyCommand } from '../runners/gate.js';
import { normalizeRelative, safeResolve } from '../core/path-safety.js';

/**
 * A forked transition chain (two receipts at one sequence, which an ordinary `git merge` produces
 * without a conflict) makes `currentStage` arbitrary — it is whichever receipt sorts last. The
 * control plane reports that as a warning plus a `transition-chain:invalid` block on every
 * transition, deliberately, so `state` and `check` keep working and the chain can be repaired.
 * Dispatch and acknowledge are not covered by that block, and both write receipts that bind to the
 * Stage, so they must refuse explicitly rather than build on a stage nobody can determine.
 */
function assertTransitionChain(control: { transitionChainValid: boolean; governance: { currentStage: string } }): void {
  if (control.transitionChainValid) return;
  throw new XForgeError(diagnostic(
    'XFORGE_TRANSITION_CHAIN_INVALID',
    `The Change's transition receipts fork, so its current Stage (${control.governance.currentStage}) is not determinable. Repair the chain before dispatching or acknowledging work.`,
  ));
}

export async function executeWorkPackageDispatch(project: ProjectContext, options: { change: string; packageId: string; dryRun: boolean }): Promise<{
  data: { change: string; packageId: string; receipt: WorkPackageDispatchReceipt; dryRun: boolean };
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'work-package dispatch');
  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', 'work-package dispatch requires a Protocol 2 governed Flow.'));
  const resources = await loadSelectedResources(project);
  const workPackages = await resolveWorkPackages(project, options.change, resolved.config, resources);
  if (!workPackages.state) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_PLAN_REQUIRED', 'The Change does not contain work-packages.yaml.'));
  resolved.state.workPackages = workPackages.state;
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config);
  assertTransitionChain(control);
  if (control.governance.currentStage !== 'apply') throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_STAGE_FORBIDDEN', `Work packages may only be dispatched in apply; current Stage is ${control.governance.currentStage}.`));
  const selected = workPackages.state.packages.find((item) => item.id === options.packageId);
  if (!selected) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_UNKNOWN', `Unknown work package: ${options.packageId}.`));
  const diagnostics = [...resolved.diagnostics, ...resources.diagnostics, ...workPackages.diagnostics, ...control.diagnostics];
  if (diagnostics.some((item) => item.severity === 'error')) {
    throw new XForgeError(diagnostics, { root: project.root });
  }
  if (selected.status !== 'ready') throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_NOT_READY', `Work package ${options.packageId} is ${selected.status}.`));

  const executionId = randomUUID();
  const auditCorrelationId = randomUUID();
  const unsigned = {
    apiVersion: 'xforge.dev/v1alpha2' as const,
    kind: 'WorkPackageDispatchReceipt' as const,
    change: options.change,
    packageId: options.packageId,
    executionId,
    stateRevision: control.governance.revision.stateRevision,
    policySnapshotDigest: control.governance.revision.policySnapshotDigest,
    gitBase: control.governance.revision.gitBase,
    gitHead: control.governance.revision.gitHead,
    auditCorrelationId,
    issuedAt: new Date().toISOString(),
  };
  const receipt: WorkPackageDispatchReceipt = { ...unsigned, digest: sha256(stableStringify(unsigned)) };
  const target = `${project.changesPath}/${options.change}/evidence/agents/${options.packageId}/dispatch/${executionId}.json`;
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  const changes: FileChange[] = [{ action: 'create', path: target, digest: sha256(content), source: `work-package:${options.packageId}:dispatch` }];
  if (!options.dryRun) {
    await atomicWrite(project.root, target, content);
    try {
      await recordAudit(project, {
        eventType: 'work-package.dispatched', change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage,
        workPackage: options.packageId, correlationId: auditCorrelationId, revision: control.governance.revision,
        actor: { id: process.env.USER ?? 'unknown', provider: 'local-os', role: 'coordinator', type: 'human' },
        outcome: 'succeeded', input: { packageId: options.packageId, executionId, dispatchDigest: receipt.digest },
      });
    } catch (error) {
      /*
       * A retry after a failed recordAudit would otherwise mint a fresh executionId and leave this
       * orphaned receipt behind as a duplicate dispatch with no matching audit event. Removing it
       * here means a retry starts clean, exactly as `transition.ts`/`approve.ts` already do for
       * their own receipts.
       */
      await rm(await safeResolve(project.root, target), { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return { data: { change: options.change, packageId: options.packageId, receipt, dryRun: options.dryRun }, diagnostics, changes };
}

/**
 * Computes the delivery record's machine-known half and hands it back for the Agent to complete.
 *
 * Every field below already exists inside XForge at the moment it is asked for. `execution_id`,
 * `base_commit` and the three bindings are read back out of the dispatch receipt this CLI issued;
 * `head_commit` is HEAD; `changed_paths` is a diff; each `exit_code` comes from running the declared
 * `verify` argv through the same spawner Gates use. Requiring all of it to be retyped bought nothing
 * and cost transcription errors — a live run lost two round trips to a `::`-terminated command value
 * that broke the YAML parse, in a field the CLI could have emitted correctly.
 *
 * What it deliberately does not produce is the part only the executor can supply, and it does not
 * write a file:
 *
 * - `status` is a claim about whether the work was done. XForge computing it would be XForge
 *   deciding the thing the delivery exists to record. It is absent from the draft.
 * - `done_when_evidence[].evidence` arrives as empty lists, one per criterion, in the plan's exact
 *   wording. Which artifact establishes which criterion is a semantic judgement; the machine can
 *   check that a citation is a real changed path or a real command, and it does, but it cannot know
 *   what the citation is meant to prove.
 * - `issues` is what the executor met and nothing else knows.
 *
 * The result is returned, never filed. A delivery is the Worker's assertion, and a CLI that wrote
 * one into `evidence/agents/` would be signing that assertion on the Worker's behalf — the same
 * mistake as an Agent filling in a human's `decidedBy`, in the opposite direction.
 */
export async function executeWorkPackageDraft(project: ProjectContext, options: {
  change: string;
  packageId: string;
}): Promise<{
  data: {
    change: string;
    packageId: string;
    executionId: string;
    target: string;
    supply: string[];
    delivery: Record<string, unknown>;
  };
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'work-package draft');
  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', 'work-package draft requires a Protocol 2 governed Flow.'));
  const resources = await loadSelectedResources(project);
  const workPackages = await resolveWorkPackages(project, options.change, resolved.config, resources);
  if (!workPackages.state) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_PLAN_REQUIRED', 'The Change does not contain work-packages.yaml.'));
  const selected = workPackages.state.packages.find((item) => item.id === options.packageId);
  if (!selected) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_UNKNOWN', `Unknown work package: ${options.packageId}.`));

  const { dispatch, diagnostics: dispatchDiagnostics } = await latestDispatchFor(project, options.change, options.packageId);
  if (!dispatch) {
    throw new XForgeError(diagnostic(
      'XFORGE_WORK_PACKAGE_DISPATCH_REQUIRED',
      `No dispatch receipt exists for ${options.packageId}, so there is no execution to draft a delivery for. Run xforge work-package dispatch --change ${options.change} --package ${options.packageId} first.`,
    ), {
      nextActions: [{ action: 'dispatch-work-package', actor: 'main', reason: 'A delivery records one dispatched execution.', command: ['xforge', 'work-package', 'dispatch', '--change', options.change, '--package', options.packageId] }],
    });
  }

  const diagnostics: Diagnostic[] = [...dispatchDiagnostics];
  const head = await git(project.root, ['rev-parse', 'HEAD']);
  if (head.code !== 0 || !/^[0-9a-fA-F]{40}$/.test(head.stdout.trim())) {
    throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_GIT_REQUIRED', 'Drafting a delivery requires a valid Git HEAD commit.'));
  }
  const headCommit = head.stdout.trim();
  /*
   * The base is the commit that *contains* the dispatch receipt, not the HEAD the receipt recorded.
   *
   * They differ by exactly one commit and the difference is the trap `validateSuccessfulDelivery`
   * documents: dispatching writes the receipt and the audit index, and those are committed after the
   * command returns, so `gitHead` names the commit before its own dispatch. A delivery based there
   * sweeps XForge's own bookkeeping into `base..head`, where it is indistinguishable from the
   * Worker's output and trips the write-boundary check for something the Worker did not do.
   *
   * A hand-written delivery had to know that. Drafting it is the natural place for the knowledge to
   * live, so the value is derived from the receipt's own history rather than from the field that
   * looks right.
   */
  const receiptPath = `${project.changesPath}/${options.change}/evidence/agents/${options.packageId}/dispatch/${dispatch.executionId}.json`;
  const added = await git(project.root, ['log', '--format=%H', '--diff-filter=A', '--', receiptPath]);
  const baseCommit = added.code === 0 && /^[0-9a-fA-F]{40}$/.test(added.stdout.trim().split('\n')[0] ?? '')
    ? added.stdout.trim().split('\n')[0]!
    : null;
  if (!baseCommit) {
    throw new XForgeError(diagnostic(
      'XFORGE_WORK_PACKAGE_DISPATCH_UNCOMMITTED',
      `The dispatch receipt at ${receiptPath} is not in any commit, so there is no base commit for this execution. Commit the dispatch receipt before the Worker starts: a delivery is measured from the commit that dispatched it.`,
      receiptPath,
    ));
  }
  const diff = await git(project.root, ['diff', '--name-only', '--no-renames', '-z', `${baseCommit}...${headCommit}`, '--']);
  if (diff.code !== 0) {
    throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_GIT_DIFF_FAILED', `Unable to diff ${baseCommit}...${headCommit}.`, undefined, 'error', { stderr: diff.stderr.trim() }));
  }
  const changedPaths = [...new Set(diff.stdout.split('\0').filter(Boolean).map((item) => normalizeRelative(item, 'Git changed path')))].sort();

  /*
   * Ordered exactly as the plan declares them, because a delivery's recorded commands must match the
   * declared `verify` entries one for one and in order. Producing them here is what makes that
   * requirement mechanical instead of a transcription exercise.
   */
  const gates = workPackageVerificationGates(workPackages.state).filter((entry) => entry.packageId === options.packageId);
  const validation: Array<{ command: string; exit_code: number | null }> = [];
  for (const entry of gates) {
    const run = await runVerifyCommand(project, entry.gate);
    validation.push({ command: entry.command, exit_code: run.exitCode });
    if (run.unavailable) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_VERIFY_UNAVAILABLE', `verify command "${entry.command}" could not be run: ${run.unavailable}. The draft records its exit code as observed; fix the command or the environment rather than editing the number.`, workPackages.state.path, 'warning'));
    }
    if (run.timedOut) {
      diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_VERIFY_TIMEOUT', `verify command "${entry.command}" timed out.`, workPackages.state.path, 'warning'));
    }
  }

  const delivery: Record<string, unknown> = {
    execution_id: dispatch.executionId,
    recorded_at: new Date().toISOString(),
    package_id: options.packageId,
    base_commit: baseCommit,
    head_commit: headCommit,
    changed_paths: changedPaths,
    validation,
    state_revision: dispatch.stateRevision,
    policy_snapshot_digest: dispatch.policySnapshotDigest,
    audit_correlation_id: dispatch.auditCorrelationId,
    done_when_evidence: selected.done_when.map((criterion) => ({ criterion, evidence: [] as string[] })),
  };

  if (changedPaths.length === 0) {
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_EMPTY_DELIVERY', `Nothing changed between ${baseCommit} and HEAD, so this draft has no changed_paths and no evidence entry can cite one. If the work is committed elsewhere, draft from the worktree that holds it.`, workPackages.state.path, 'warning'));
  }

  return {
    data: {
      change: options.change,
      packageId: options.packageId,
      executionId: dispatch.executionId,
      target: `${project.changesPath}/${options.change}/evidence/agents/${options.packageId}/${dispatch.executionId}.yaml`,
      supply: [
        'status — succeeded, blocked or failed; your claim about this execution, which XForge will not make for you',
        'done_when_evidence[].evidence — each entry beginning with an exact changed_paths entry or an exact validation command, explanation after " — "',
        'issues — anything unresolved; [] if none',
      ],
      delivery,
    },
    diagnostics,
    changes: [],
  };
}

export async function executeWorkPackageAcknowledge(project: ProjectContext, options: {
  change: string;
  packageId: string;
  role: 'integrator' | 'reviewer';
  evidence: string;
  dryRun: boolean;
}): Promise<{
  data: { change: string; packageId: string; role: 'integrator' | 'reviewer'; evidence: string; status: 'integrated' | 'reviewed'; dryRun: boolean };
  diagnostics: Diagnostic[];
  changes: FileChange[];
}> {
  assertManaged(project, 'work-package acknowledge');
  const evidence = normalizeRelative(options.evidence, 'work-package acknowledgement evidence');
  const evidenceRoot = `${project.changesPath}/${options.change}/evidence/agents/${options.packageId}/`;
  if (!evidence.startsWith(evidenceRoot)) {
    throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_ACK_EVIDENCE_SCOPE', `Acknowledgement evidence must be stored below ${evidenceRoot}.`, evidence));
  }
  const evidenceAbsolute = await safeResolve(project.root, evidence);
  let evidenceStat;
  try { evidenceStat = await stat(evidenceAbsolute); }
  catch { throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_ACK_EVIDENCE_MISSING', 'Acknowledgement evidence does not exist.', evidence)); }
  if (!evidenceStat.isFile()) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_ACK_EVIDENCE_MISSING', 'Acknowledgement evidence must be a regular file.', evidence));

  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', 'work-package acknowledge requires a Protocol 2 governed Flow.'));
  const resources = await loadSelectedResources(project);
  const workPackages = await resolveWorkPackages(project, options.change, resolved.config, resources);
  if (!workPackages.state) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_PLAN_REQUIRED', 'The Change does not contain work-packages.yaml.'));
  resolved.state.workPackages = workPackages.state;
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config);
  assertTransitionChain(control);
  const diagnostics = [...resolved.diagnostics, ...resources.diagnostics, ...workPackages.diagnostics, ...control.diagnostics];
  if (diagnostics.some((item) => item.severity === 'error')) throw new XForgeError(diagnostics, { root: project.root });
  const selected = workPackages.state.packages.find((item) => item.id === options.packageId);
  if (!selected) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_UNKNOWN', `Unknown work package: ${options.packageId}.`));
  const acceptable = options.role === 'integrator'
    ? ['succeeded', 'integrated', 'reviewed']
    : ['integrated', 'reviewed'];
  if (!acceptable.includes(selected.status)) {
    throw new XForgeError(diagnostic(
      'XFORGE_WORK_PACKAGE_ACK_NOT_READY',
      `${options.role} acknowledgement requires ${options.role === 'integrator' ? 'a succeeded delivery' : 'an integrated delivery'}; current status is ${selected.status}.`,
    ));
  }
  const status: 'integrated' | 'reviewed' = options.role === 'integrator' ? 'integrated' : 'reviewed';
  /*
   * A re-acknowledgement that would not advance the package's lifecycle (already at `status`, or
   * already at the terminal `reviewed`) records nothing new: no audit event and no receipt, so a
   * redundant call stays a true no-op rather than accumulating duplicate ack receipts.
   */
  const shouldRecord = selected.status !== status && selected.status !== 'reviewed';
  const changes: FileChange[] = [];
  if (shouldRecord) {
    if (!selected.delivery) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_ACK_DELIVERY_MISSING', `Acknowledgement requires a delivery for ${options.packageId}.`));
    const executionId = selected.delivery.execution_id;
    const deliveryDigest = sha256(stableStringify(selected.delivery));
    const unsigned = {
      apiVersion: 'xforge.dev/v1alpha2' as const,
      kind: 'WorkPackageAckReceipt' as const,
      receiptId: randomUUID(),
      change: options.change,
      packageId: options.packageId,
      executionId,
      as: options.role,
      status,
      deliveryDigest,
      actor: { id: process.env.USER ?? 'unknown', provider: 'local-os', role: options.role, type: 'agent' as const },
      acknowledgedAt: new Date().toISOString(),
    };
    const receipt: WorkPackageAckReceipt = { ...unsigned, digest: sha256(stableStringify(unsigned)) };
    const target = `${project.changesPath}/${options.change}/evidence/agents/${options.packageId}/ack/${executionId}-${options.role}.json`;
    const content = `${JSON.stringify(receipt, null, 2)}\n`;
    changes.push({ action: 'create', path: target, digest: sha256(content), source: `work-package:acknowledge:${options.role}` });
    if (!options.dryRun) {
      await atomicWrite(project.root, target, content);
      try {
        await recordAudit(project, {
          eventType: `work-package.${status}`,
          change: options.change,
          flow: resolved.flow.metadata.name,
          stage: control.governance.currentStage,
          workPackage: options.packageId,
          correlationId: selected.delivery?.audit_correlation_id,
          revision: control.governance.revision,
          actor: { id: process.env.USER ?? 'unknown', provider: 'local-os', role: options.role, type: 'agent' },
          outcome: 'succeeded',
          /*
           * This event *is* the attestation that makes the committed receipt believable, so its
           * `inputDigest` has to be something the read side can recompute from the receipt alone on
           * a machine that never ran this command. `acknowledgementAttestationDigest` is that shared
           * definition; passing it explicitly (rather than letting `recordAudit` hash a richer
           * `input`) is what keeps the two sides from ever drifting.
           */
          inputDigest: acknowledgementAttestationDigest(receipt.digest),
          /* The surrounding context stays committed to, via the event's outputDigest. */
          output: { packageId: options.packageId, deliveryExecutionId: executionId, evidence, ackReceipt: receipt.digest },
        });
      } catch (error) {
        /*
         * Without a matching audit event a retry would otherwise see the receipt file already on
         * disk and skip re-recording (the digest/executionId/as filename would collide), leaving the
         * acknowledgement half-recorded. Remove it so a retry starts clean, same as dispatch/transition/approve.
         */
        await rm(await safeResolve(project.root, target), { force: true }).catch(() => undefined);
        throw error;
      }
    }
  }
  return { data: { change: options.change, packageId: options.packageId, role: options.role, evidence, status, dryRun: options.dryRun }, diagnostics, changes };
}
