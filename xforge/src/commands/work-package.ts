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
import { resolveWorkPackages } from '../core/work-packages.js';
import { normalizeRelative, safeResolve } from '../core/path-safety.js';

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
