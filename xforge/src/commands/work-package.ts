import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import type { Diagnostic, FileChange, ProjectContext, WorkPackageAckReceipt, WorkPackageDispatchReceipt } from '../types.js';
import { acknowledgementAttestationDigest, recordAudit } from '../core/audit.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { sha256, stableStringify } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { git, resolveWorkPackages, workPackageVerificationGates } from '../core/work-packages.js';
import { latestDispatchFor } from '../core/work-packages/records.js';
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
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config, { workPackages });
  assertTransitionChain(control);
  if (control.governance.currentStage !== 'apply') throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_STAGE_FORBIDDEN', `Work packages may only be dispatched in apply; current Stage is ${control.governance.currentStage}.`));
  const selected = workPackages.state.packages.find((item) => item.id === options.packageId);
  if (!selected) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_UNKNOWN', `Unknown work package: ${options.packageId}.`));
  const diagnostics = [...resolved.diagnostics, ...resources.diagnostics, ...workPackages.diagnostics, ...control.diagnostics];
  if (diagnostics.some((item) => item.severity === 'error')) {
    throw new XForgeError(diagnostics, { root: project.root });
  }
  /*
   * `failed` is dispatchable. Everything else that is not `ready` is refused with the way out.
   *
   * A package whose delivery failed -- because the work did not hold, or because an independent
   * review returned `changes-required` and the delivery was recorded as failed -- is exactly the
   * package that has to be done again. It was refused here, and nothing anywhere named a route: the
   * message said "Work package T001 is failed.", `explain` returned the same sentence back, and
   * `nextActions` offered only backward Stage transitions. A live Major run got out by reading this
   * package's own compiled source to learn that status is derived from the latest delivery file, and
   * then hand-editing that file -- twice. A rework loop that only a reader of `dist/` can close is
   * not a rework loop.
   *
   * Re-dispatching mints a new `executionId`, so the rejected delivery stays on disk exactly as it
   * was reviewed and the new attempt is measured from its own base commit. Nothing is overwritten,
   * which is the difference between this and editing the record that a reviewer already read.
   */
  if (selected.status !== 'ready' && selected.status !== 'failed') {
    const draft = `\`xforge work-package draft --change ${options.change} --package ${options.packageId}\``;
    const remedy = selected.status === 'running'
      ? `It was already dispatched${selected.executionId ? ` as ${selected.executionId}` : ''} and no delivery has been recorded for that execution yet. Record the delivery — ${draft} writes the half XForge already knows — and dispatch again only if it is recorded as failed.`
      : selected.status === 'blocked'
        ? `It is waiting on ${selected.missingDependencies.length > 0 ? `dependencies that have not succeeded: ${selected.missingDependencies.join(', ')}` : 'a dependency that has not succeeded'}. Deliver those first; this one becomes ready on its own.`
        : `Its delivery succeeded, so there is nothing to dispatch. If a review rejected it, record a delivery for execution ${selected.delivery?.execution_id ?? '<execution>'} with \`status: failed\` (start from ${draft}), which returns the package to failed, then dispatch again — a rejected package is re-done as a new execution, never by editing the record the reviewer read.`;
    throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_NOT_READY', `Work package ${options.packageId} is ${selected.status}. ${remedy}`));
  }

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
  /* `true`: a draft exists only for a dispatched execution, which this command has already read. */
  const gates = workPackageVerificationGates(workPackages.state, true).filter((entry) => entry.packageId === options.packageId);
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
    /*
     * A non-zero exit, with what the command said about it.
     *
     * The draft recorded the number and nothing else, so a red suite produced `exit_code: 1` in a
     * YAML file and no clue which case failed; the only way to find out was to run the suite again
     * by hand, which a field report did. The output was already captured and thrown away one
     * function up. Nothing here decides whether the failure is real — that is the Worker's to read
     * — this only stops the command from knowing and not saying.
     *
     * A distinct code from `check`'s `XFORGE_WORK_PACKAGE_VERIFY_FAILED`, which is an error that
     * blocks: there the run is the verdict, here it is an observation being recorded. One code at
     * two severities would make the catalogue unable to say which of those a reader is holding.
     */
    if (run.exitCode !== 0 && !run.unavailable && !run.timedOut) {
      diagnostics.push(diagnostic(
        'XFORGE_WORK_PACKAGE_VERIFY_NONZERO',
        `verify command "${entry.command}" exited ${run.exitCode}. The draft records it as observed. ${verifyTail(run)}`,
        workPackages.state.path,
        'warning',
        { command: entry.command, exitCode: run.exitCode },
      ));
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
    /*
     * The cause first, then the other cause. This named the worktree case alone, and the far more
     * common one -- the dispatch receipt committed together with the implementation, which makes
     * base and head the same commit -- was explained in a different diagnostic
     * (`XFORGE_WORK_PACKAGE_DISPATCH_UNCOMMITTED`) that a Stage only meets if it happens to hit that
     * path first. Three live runs reached this message, and each spent five or six calls, a
     * `git reset`, and in one case a `git worktree` that was never needed, before finding the rule.
     */
    diagnostics.push(diagnostic('XFORGE_WORK_PACKAGE_EMPTY_DELIVERY', `Nothing changed between ${baseCommit} and HEAD, so this draft has no changed_paths and no evidence entry can cite one. A delivery is measured from the commit that dispatched it, so ${baseCommit} is the commit holding this execution's dispatch receipt: if the receipt and the implementation went into that same commit, there is nothing after it to measure and the receipt has to be its own commit, before the work. If instead the work is committed elsewhere, draft from the worktree that holds it.`, workPackages.state.path, 'warning'));
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

/**
 * The end of what a failed verify command printed.
 *
 * The tail rather than the head, because a test runner prints its failures last — but the capture
 * keeps the *head* of each stream (`appendBounded`), so when it hit the cap the tail of what
 * survived is not the tail of what was written. That case is stated rather than papered over: a
 * quoted fragment that silently is not the failure is worse than an admission that it might not be.
 *
 * stderr first when there is any, since a runner that separates the streams puts the failure there.
 */
function verifyTail(run: { stdout: string; stderr: string; outputTruncated: boolean }, lines = 20): string {
  const stream = run.stderr.trim().length > 0 ? run.stderr : run.stdout;
  const tail = stream.split('\n').filter((line) => line.trim().length > 0).slice(-lines).join('\n').trim();
  if (tail.length === 0) return 'It printed nothing.';
  const caveat = run.outputTruncated
    ? ' Its output hit the capture limit, and the capture keeps the beginning of the stream — so this is the end of what was kept, which may not be the end of what ran.'
    : '';
  return `Last ${Math.min(lines, tail.split('\n').length)} line(s) of its output:${caveat}\n${tail}`;
}

export async function executeWorkPackageAcknowledge(project: ProjectContext, options: {
  change: string;
  packageId: string;
  role: 'integrator' | 'reviewer';
  evidence: string;
  /** What this acknowledgement covered, verbatim from the acknowledger; never inferred. */
  scope?: string;
  dryRun: boolean;
}): Promise<{
  data: {
    change: string; packageId: string; role: 'integrator' | 'reviewer'; evidence: string;
    status: 'integrated' | 'reviewed';
    /** Whether a receipt was written. False means the acknowledgement already covered this delivery. */
    recorded: boolean;
    /** Whether the receipt replaced one whose delivery digest had moved. */
    superseded: boolean;
    dryRun: boolean;
  };
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
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config, { workPackages });
  assertTransitionChain(control);
  const diagnostics = [...resolved.diagnostics, ...resources.diagnostics, ...workPackages.diagnostics, ...control.diagnostics];
  if (diagnostics.some((item) => item.severity === 'error')) throw new XForgeError(diagnostics, { root: project.root });
  const selected = workPackages.state.packages.find((item) => item.id === options.packageId);
  if (!selected) throw new XForgeError(diagnostic('XFORGE_WORK_PACKAGE_UNKNOWN', `Unknown work package: ${options.packageId}.`));
  const acceptable = options.role === 'integrator'
    ? ['succeeded', 'integrated', 'reviewed']
    : ['integrated', 'reviewed'];
  if (!acceptable.includes(selected.status)) {
    /*
     * Naming the rung below is the whole fix here. A package climbs `succeeded -> integrated ->
     * reviewed`, and each acknowledgement is refused until the one beneath it exists. Saying only
     * "requires an integrated delivery; current status is succeeded" states the refusal without
     * ever stating the ladder, and a live Major run read it as "review is recorded against the
     * integrator package", carried that conclusion into a report to its user, and was corrected
     * only later by an unrelated block. The sibling refusal above already supplies the command
     * that unblocks it; this one now does too.
     */
    const blockedOnIntegrator = options.role === 'reviewer' && selected.status === 'succeeded';
    throw new XForgeError(diagnostic(
      'XFORGE_WORK_PACKAGE_ACK_NOT_READY',
      `${options.role} acknowledgement requires ${options.role === 'integrator' ? 'a succeeded delivery' : 'an integrated delivery'}; current status is ${selected.status}.`
        + ` A work package is acknowledged in order: the delivery reaches succeeded, an integrator acknowledges it as integrated, and only then may a reviewer acknowledge it as reviewed.`
        + (blockedOnIntegrator
          ? ` Run xforge work-package acknowledge --change ${options.change} --package ${options.packageId} --as integrator --evidence <path> first.`
          : ''),
    ), blockedOnIntegrator
      ? {
        nextActions: [{
          action: 'acknowledge-work-package',
          actor: 'main',
          reason: 'A reviewer acknowledgement requires an integrated delivery to review.',
          command: ['xforge', 'work-package', 'acknowledge', '--change', options.change, '--package', options.packageId, '--as', 'integrator'],
        }],
      }
      : undefined);
  }
  const status: 'integrated' | 'reviewed' = options.role === 'integrator' ? 'integrated' : 'reviewed';
  /*
   * Two different questions, and conflating them cost a live run its record.
   *
   * The first is "would this advance the lifecycle": a redundant call must not accumulate duplicate
   * receipts, and that is what the status comparison answers.
   *
   * The second is "does an acknowledgement still cover the delivery that exists". It usually does,
   * and after a review that asks for the delivery record to be corrected it does not: the delivery's
   * digest moves, `loadAckReceipts` drops the receipts that cite the old one, and every one of them
   * is reported as XFORGE_WORK_PACKAGE_ACK_RECEIPT_DELIVERY_MISMATCH. Re-acknowledging then did
   * nothing at all and still returned ok, because the lifecycle had already reached `reviewed` --
   * and it stays there whatever happens to the receipt files, since the status is driven by an
   * append-only chain (`work-package.reviewed`) and not by the files. Deleting the receipts did not
   * help either. The two ways out were "keep permanent mismatch warnings" or "lose the record that
   * the acknowledgement happened", and a live run had to choose one.
   *
   * `acknowledgements` is what tells them apart. It is populated only from receipts that match the
   * *current* delivery, so `status: 'reviewed'` with `reviewedBy: null` is precisely the state where
   * the lifecycle says the work was acknowledged and no surviving receipt says so.
   */
  const attributed = options.role === 'integrator' ? selected.acknowledgements.integratedBy : selected.acknowledgements.reviewedBy;
  const advances = selected.status !== status && selected.status !== 'reviewed';
  const supersedes = attributed === null;
  const shouldRecord = advances || supersedes;
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
      /* Omitted rather than defaulted when unstated — a receipt that claims a reach nobody gave it
         is worse evidence than one that admits it has none. */
      ...(options.scope ? { scope: options.scope } : {}),
      actor: { id: process.env.USER ?? 'unknown', provider: 'local-os', role: options.role, type: 'agent' as const },
      acknowledgedAt: new Date().toISOString(),
    };
    const receipt: WorkPackageAckReceipt = { ...unsigned, digest: sha256(stableStringify(unsigned)) };
    const target = `${project.changesPath}/${options.change}/evidence/agents/${options.packageId}/ack/${executionId}-${options.role}.json`;
    const content = `${JSON.stringify(receipt, null, 2)}\n`;
    /*
     * The bytes this call is about to replace, if any. A supersede writes to the path an earlier
     * receipt already occupies — same execution, same role, because the delivery record was
     * corrected rather than re-executed — so `create` is only true the first time.
     *
     * Read before the write and on every run, `--dry-run` included: the rehearsal's whole job is to
     * report the plan the real run would carry out, and reading only when about to write made
     * `--dry-run` announce `create` for a path an existing receipt occupies. It doubles as the
     * rollback copy below, which is why it is a Buffer rather than a boolean.
     */
    let priorReceipt: Buffer | null = null;
    try { priorReceipt = await readFile(await safeResolve(project.root, target)); }
    catch { priorReceipt = null; }
    changes.push({ action: priorReceipt ? 'modify' : 'create', path: target, digest: sha256(content), source: `work-package:acknowledge:${options.role}` });
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
          /* Why a second one exists for the same execution, on the chain that keeps both. */
          ...(supersedes && !advances
            ? { reason: `Supersedes an earlier ${options.role} acknowledgement of ${options.packageId} whose delivery digest no longer matches; the delivery record was corrected after it was signed.` }
            : {}),
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
         * acknowledgement half-recorded. Undo the write so a retry starts clean, same as
         * dispatch/transition/approve.
         *
         * Restore rather than remove when something was already there. On a supersede the target is
         * an earlier receipt that is committed and attested, and deleting it would answer a failure
         * to *record* an acknowledgement by destroying a different one — turning a retryable error
         * into lost evidence. `runners/gate.ts` keeps its prior Evidence for the same reason.
         */
        if (priorReceipt) await atomicWrite(project.root, target, priorReceipt.toString('utf8')).catch(() => undefined);
        else await rm(await safeResolve(project.root, target), { force: true }).catch(() => undefined);
        throw error;
      }
    }
  }
  /*
   * Say which of the three happened. Silence was the defect: a call that recorded nothing returned
   * `ok: true` and left the operator to discover from `xforge state` that two real acknowledgements
   * had no surviving record.
   */
  if (shouldRecord && supersedes && !advances) {
    diagnostics.push(diagnostic(
      'XFORGE_WORK_PACKAGE_ACK_SUPERSEDED',
      `${options.packageId} was already ${status}, and no surviving ${options.role} receipt covered the delivery as it now stands — the delivery record changed after it was signed. A new receipt was recorded for the current delivery; the earlier acknowledgement stays on the audit chain, which is where the history lives.`,
      `${project.changesPath}/${options.change}/evidence/agents/${options.packageId}`,
      'info',
      { packageId: options.packageId, as: options.role },
    ));
  }
  if (!shouldRecord) {
    diagnostics.push(diagnostic(
      'XFORGE_WORK_PACKAGE_ACK_UNCHANGED',
      `${options.packageId} is already ${selected.status} and its ${options.role} acknowledgement covers the current delivery, so nothing was recorded. This is not a failure and not a second signature: re-running the command changes nothing while the delivery stays as it is.`,
      `${project.changesPath}/${options.change}/evidence/agents/${options.packageId}`,
      'info',
      { packageId: options.packageId, as: options.role, status: selected.status },
    ));
  }
  return { data: { change: options.change, packageId: options.packageId, role: options.role, evidence, status, recorded: shouldRecord, superseded: shouldRecord && supersedes && !advances, dryRun: options.dryRun }, diagnostics, changes };
}
