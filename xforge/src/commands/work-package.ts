import { randomUUID } from 'node:crypto';
import type { Diagnostic, FileChange, ProjectContext, WorkPackageDispatchReceipt } from '../types.js';
import { recordAudit } from '../core/audit.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { sha256, stableStringify } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveWorkPackages } from '../core/work-packages.js';

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
    await recordAudit(project, {
      eventType: 'work-package.dispatched', change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage,
      workPackage: options.packageId, correlationId: auditCorrelationId, revision: control.governance.revision,
      actor: { id: process.env.USER ?? 'unknown', provider: 'local-os', role: 'coordinator', type: 'human' },
      outcome: 'succeeded', input: { packageId: options.packageId, executionId, dispatchDigest: receipt.digest },
    });
  }
  return { data: { change: options.change, packageId: options.packageId, receipt, dryRun: options.dryRun }, diagnostics: [...resources.diagnostics, ...workPackages.diagnostics, ...control.diagnostics], changes };
}
