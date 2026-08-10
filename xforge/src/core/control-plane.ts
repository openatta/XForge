import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ApprovalPolicy,
  ApprovalReceipt,
  ChangeState,
  Diagnostic,
  GateEvidence,
  GovernanceState,
  ProjectContext,
  StageFlow,
  TransitionReceipt,
} from '../types.js';
import { diagnostic } from './errors.js';
import { normalizeRule, policyApplies, ruleApplies } from './governance.js';
import { sha256, stableStringify } from './hash.js';
import { safeResolve } from './path-safety.js';
import type { SelectedResources } from './resource-loader.js';
import { computeGovernanceRevision } from './revision.js';
import { validateSchema } from './validator.js';
import { readAuditEvents, verifyAudit } from './audit.js';
import { verifyApprovalReceipt } from './approval-receipt.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

function receiptDigest<T extends { digest: string }>(receipt: T): string {
  const { digest: _digest, ...unsigned } = receipt;
  return sha256(stableStringify(unsigned));
}

async function jsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
}

export async function loadTransitionReceipts(
  project: ProjectContext,
  changeId: string,
  flow: StageFlow,
): Promise<{ receipts: TransitionReceipt[]; diagnostics: Diagnostic[] }> {
  const relative = `${project.changesPath}/${changeId}/evidence/receipts/transitions`;
  const directory = await safeResolve(project.root, relative);
  const diagnostics: Diagnostic[] = [];
  const receipts: TransitionReceipt[] = [];
  for (const name of await jsonFiles(directory)) {
    const receiptPath = `${relative}/${name}`;
    let receipt: TransitionReceipt;
    try { receipt = JSON.parse(await readFile(await safeResolve(project.root, receiptPath), 'utf8')) as TransitionReceipt; }
    catch (error) {
      diagnostics.push(diagnostic('XFORGE_TRANSITION_RECEIPT_INVALID', `Transition receipt is not valid JSON: ${(error as Error).message}`, receiptPath));
      continue;
    }
    const receiptDiagnostics = await validateSchema('transition-receipt', receipt, receiptPath);
    if (receipt.digest !== receiptDigest(receipt)) receiptDiagnostics.push(diagnostic('XFORGE_TRANSITION_RECEIPT_DIGEST_INVALID', 'Transition receipt digest is invalid.', receiptPath));
    if (receipt.change !== changeId || receipt.flow !== flow.metadata.name) receiptDiagnostics.push(diagnostic('XFORGE_TRANSITION_RECEIPT_SUBJECT_MISMATCH', 'Transition receipt is bound to a different Change or Flow.', receiptPath));
    diagnostics.push(...receiptDiagnostics);
    if (receiptDiagnostics.some((item) => item.severity === 'error')) continue;
    receipts.push(receipt);
  }
  receipts.sort((left, right) => left.sequence - right.sequence);
  let previous: TransitionReceipt | null = null;
  let current = flow.stages[0]?.id ?? 'unknown';
  for (const receipt of receipts) {
    if (receipt.sequence !== (previous?.sequence ?? 0) + 1 || receipt.previousReceiptDigest !== (previous?.digest ?? null) || receipt.from !== current) {
      diagnostics.push(diagnostic('XFORGE_TRANSITION_CHAIN_INVALID', `Transition chain is invalid at sequence ${receipt.sequence}.`, relative));
    }
    previous = receipt;
    current = receipt.to;
  }
  return { receipts, diagnostics };
}

export async function loadApprovalReceipts(
  project: ProjectContext,
  changeId: string,
): Promise<{ receipts: ApprovalReceipt[]; diagnostics: Diagnostic[] }> {
  const rootRelative = `${project.changesPath}/${changeId}/approvals`;
  const root = await safeResolve(project.root, rootRelative);
  const diagnostics: Diagnostic[] = [];
  const receipts: ApprovalReceipt[] = [];
  let policyDirectories: string[] = [];
  try { policyDirectories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch { return { receipts, diagnostics }; }
  for (const policy of policyDirectories) {
    const directory = path.join(root, policy);
    for (const name of await jsonFiles(directory)) {
      const relative = `${rootRelative}/${policy}/${name}`;
      let receipt: ApprovalReceipt;
      try { receipt = JSON.parse(await readFile(await safeResolve(project.root, relative), 'utf8')) as ApprovalReceipt; }
      catch (error) {
        diagnostics.push(diagnostic('XFORGE_APPROVAL_RECEIPT_INVALID', `Approval receipt is not valid JSON: ${(error as Error).message}`, relative));
        continue;
      }
      const receiptDiagnostics = await validateSchema('approval-receipt', receipt, relative);
      receiptDiagnostics.push(...verifyApprovalReceipt(project, receipt).map((item) => ({ ...item, path: relative })));
      if (receipt.change !== changeId || receipt.policyId !== policy) receiptDiagnostics.push(diagnostic('XFORGE_APPROVAL_RECEIPT_SUBJECT_MISMATCH', 'Approval receipt path does not match its subject.', relative));
      diagnostics.push(...receiptDiagnostics);
      if (receiptDiagnostics.some((item) => item.severity === 'error')) continue;
      receipts.push(receipt);
    }
  }
  return { receipts, diagnostics };
}

export function approvalsForPolicy(
  receipts: ApprovalReceipt[],
  policy: ApprovalPolicy,
  transition: string,
  stateRevision: string,
): { valid: ApprovalReceipt[]; missing: number; rejected: boolean; separationSatisfied: boolean } {
  const now = Date.now();
  const applicable = receipts.filter((receipt) => receipt.policyId === policy.id && receipt.transition === transition && receipt.stateRevision === stateRevision &&
    (!receipt.expiresAt || Date.parse(receipt.expiresAt) > now) && policy.providers.includes(receipt.approver.provider) && policy.roles.includes(receipt.approver.role));
  const rejected = applicable.some((receipt) => receipt.decision === 'reject');
  const byActor = new Map(applicable.filter((receipt) => receipt.decision === 'approve').map((receipt) => [receipt.approver.id, receipt]));
  const valid = [...byActor.values()];
  const separationSatisfied = !policy.separationOfDuties || new Set(valid.map((receipt) => receipt.approver.role)).size >= Math.min(policy.minApprovers, policy.roles.length);
  return { valid, missing: Math.max(0, policy.minApprovers - valid.length), rejected, separationSatisfied };
}

function structuredExit(stage: StageFlow['stages'][number]): { conditions?: Record<string, string>; gates?: string[]; approvals?: string[]; auditEvents?: string[] } {
  const exit = stage.exit;
  if (!exit || !('conditions' in exit || 'gates' in exit || 'approvals' in exit || 'auditEvents' in exit)) return {};
  return exit;
}

async function readGateEvidence(project: ProjectContext, changeId: string, gateId: string, resources: SelectedResources): Promise<GateEvidence | null> {
  const gate = resources.gates.get(gateId)?.value;
  if (!gate) return null;
  const evidencePath = `${project.changesPath}/${changeId}/evidence/${gate.spec.evidence}`;
  const absolute = await safeResolve(project.root, evidencePath);
  if (!await exists(absolute)) return null;
  try {
    const evidence = JSON.parse(await readFile(absolute, 'utf8')) as GateEvidence;
    const { digest, ...unsigned } = evidence;
    return digest === sha256(stableStringify(unsigned)) && evidence.gate === gateId && evidence.change === changeId ? evidence : null;
  } catch { return null; }
}

function policyById(flow: StageFlow, id: string): ApprovalPolicy | null {
  return flow.governance?.approvalPolicies.find((policy) => policy.id === id) ?? null;
}

async function exitConditionSatisfied(
  project: ProjectContext,
  changeId: string,
  state: ChangeState,
  stage: StageFlow['stages'][number],
  key: string,
  expected: string,
): Promise<boolean> {
  const artifacts = stage.produces.map((id) => state.artifacts.find((artifact) => artifact.id === id)).filter(Boolean);
  const sources: string[] = [];
  for (const artifact of artifacts) {
    for (const output of artifact!.outputPaths) {
      try { sources.push(await readFile(await safeResolve(project.root, `${project.changesPath}/${changeId}/${output}`), 'utf8')); }
      catch { /* missing artifacts are reported separately */ }
    }
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedExpected = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const explicit = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:${escapedKey}|xforge-condition\\s*:\\s*${escapedKey})\\s*[:=]\\s*${escapedExpected}\\s*(?:$|\\n)`, 'i');
  if (sources.some((source) => explicit.test(source))) return true;
  return key === 'materialQuestions' && sources.some((source) => new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?status\\s*:\\s*${escapedExpected}\\s*(?:$|\\n)`, 'i').test(source));
}

export interface ResolvedControlPlane {
  governance: GovernanceState;
  diagnostics: Diagnostic[];
  flow: StageFlow;
  state: ChangeState;
  transitionRequirements: Map<string, { approvals: ApprovalReceipt[]; gates: GateEvidence[]; blockedBy: string[] }>;
  resources: SelectedResources;
}

export async function resolveControlPlane(
  project: ProjectContext,
  changeId: string,
  flow: StageFlow,
  state: ChangeState,
  resources: SelectedResources,
  config: { scope: { modules: string[]; paths: string[] }; classification: any; flow: string },
): Promise<ResolvedControlPlane> {
  const diagnostics: Diagnostic[] = [];
  const transitions = await loadTransitionReceipts(project, changeId, flow);
  const approvals = await loadApprovalReceipts(project, changeId);
  diagnostics.push(...transitions.diagnostics, ...approvals.diagnostics);
  const currentStage = transitions.receipts.at(-1)?.to ?? flow.stages[0]?.id ?? 'unknown';
  const transitionHead = transitions.receipts.at(-1)?.digest ?? null;
  const revision = await computeGovernanceRevision(project, changeId, flow, state, resources, currentStage, transitionHead);
  const auditVerification = await verifyAudit(project, changeId);
  const auditEvents = (await readAuditEvents(project)).filter((event) => event.change === changeId);
  const currentIndex = flow.stages.findIndex((stage) => stage.id === currentStage);
  const current = currentIndex >= 0 ? flow.stages[currentIndex]! : null;
  const candidates: string[] = [];
  if (current) {
    if (currentIndex < flow.stages.length - 1) candidates.push(flow.stages[currentIndex + 1]!.id);
    else candidates.push('ready-to-archive');
    for (const rework of current.reworkTo ?? []) if (rework !== current.id && !candidates.includes(rework)) candidates.push(rework);
  }
  const transitionRequirements = new Map<string, { approvals: ApprovalReceipt[]; gates: GateEvidence[]; blockedBy: string[] }>();
  const readyTransitions: GovernanceState['readyTransitions'] = [];
  const pendingApprovals: GovernanceState['pendingApprovals'] = [];

  for (const target of candidates) {
    const blockedBy: string[] = [];
    const approvalEvidence: ApprovalReceipt[] = [];
    const gateEvidence: GateEvidence[] = [];
    const isRework = currentIndex >= 0 && target !== 'ready-to-archive' && flow.stages.findIndex((stage) => stage.id === target) <= currentIndex;
    if (!isRework && current) {
      for (const artifactId of current.produces) {
        if (state.artifacts.find((artifact) => artifact.id === artifactId)?.status !== 'done') blockedBy.push(`artifact:${artifactId}`);
      }
      if (current.id === 'apply' && target === 'verify' && state.workPackages) {
        for (const workPackage of state.workPackages.packages) if (!['succeeded', 'integrated', 'reviewed'].includes(workPackage.status)) blockedBy.push(`work-package:${workPackage.id}:${workPackage.status}`);
      }
      const exit = structuredExit(current);
      for (const [key, expected] of Object.entries(exit.conditions ?? {})) {
        if (!await exitConditionSatisfied(project, changeId, state, current, key, expected)) blockedBy.push(`condition:${key}:expected-${expected}`);
      }
      for (const gateId of [...new Set([...(current.gates ?? []), ...(exit.gates ?? [])])]) {
        const evidence = await readGateEvidence(project, changeId, gateId, resources);
        if (!evidence || evidence.status !== 'passed' || evidence.stateRevision !== revision.stateRevision) blockedBy.push(`gate:${gateId}:missing-or-stale`);
        else gateEvidence.push(evidence);
      }
      for (const policyId of exit.approvals ?? []) {
        const policy = policyById(flow, policyId);
        if (!policy) { blockedBy.push(`approval-policy:${policyId}:missing`); continue; }
        const result = approvalsForPolicy(approvals.receipts, policy, target, revision.stateRevision);
        approvalEvidence.push(...result.valid);
        if (result.rejected) blockedBy.push(`approval:${policyId}:rejected`);
        if (result.missing > 0 || !result.separationSatisfied) {
          blockedBy.push(`approval:${policyId}:missing-${result.missing || 'separation'}`);
          pendingApprovals.push({ policyId, transition: target, missing: result.missing, roles: policy.roles });
        }
      }
      for (const eventType of exit.auditEvents ?? []) if (!auditEvents.some((event) => event.eventType === eventType)) blockedBy.push(`audit:${eventType}:missing`);
      if (!auditVerification.valid) blockedBy.push('audit:chain-invalid');
    }
    transitionRequirements.set(target, { approvals: approvalEvidence, gates: gateEvidence, blockedBy });
    readyTransitions.push({ to: target, ready: blockedBy.length === 0, blockedBy });
  }

  if (currentStage === 'ready-to-archive') {
    for (const policyId of flow.terminal.archive.approvals ?? []) {
      const policy = policyById(flow, policyId);
      if (!policy) continue;
      const result = approvalsForPolicy(approvals.receipts, policy, 'archive', revision.stateRevision);
      if (result.missing > 0 || result.rejected || !result.separationSatisfied) pendingApprovals.push({ policyId, transition: 'archive', missing: result.missing, roles: policy.roles });
    }
  }

  const rules = [...resources.rules.values()].map((item) => normalizeRule(item.value)).filter((rule) => ruleApplies(rule, config, currentStage)).map((rule) => {
    const coverage: GovernanceState['rules'][number]['coverage'] = ['instructed'];
    if (rule.policyRefs.some((id) => resources.policies.has(id))) coverage.push('guarded');
    const verified = rule.gateRefs.some((id) => transitionRequirements.get(candidates[0] ?? '')?.gates.some((gate) => gate.gate === id));
    if (verified) coverage.push('verified');
    const approved = rule.approvalRefs.some((id) => approvals.receipts.some((receipt) => receipt.policyId === id && receipt.decision === 'approve' && receipt.stateRevision === revision.stateRevision));
    if (approved) coverage.push('approved');
    if (rule.severity === 'must' && rule.gateRefs.length === 0 && rule.approvalRefs.length === 0) coverage.push('uncovered');
    return { id: rule.id, severity: rule.severity, instruction: rule.instruction, coverage, gateRefs: rule.gateRefs, policyRefs: rule.policyRefs, approvalRefs: rule.approvalRefs };
  });

  const governance: GovernanceState = {
    currentStage, transitionHead, transitions: transitions.receipts, revision,
    pendingApprovals: pendingApprovals.filter((item, index, all) => index === all.findIndex((candidate) => candidate.policyId === item.policyId && candidate.transition === item.transition)),
    approvals: approvals.receipts,
    rules,
    policies: [...resources.policies.values()].map((item) => ({ id: item.value.metadata.name, capability: item.value.spec.capability, effect: item.value.spec.effect, applicable: policyApplies(item.value, config, currentStage) })),
    hooks: [...resources.hooks.values()].map((item) => ({ id: item.value.metadata.name, plane: item.value.spec.plane ?? 'legacy', event: item.value.spec.event, selected: true, enabled: item.value.spec.enabled })),
    audit: { chainValid: auditVerification.valid, chainHead: auditVerification.head, eventCount: auditEvents.length, remotePending: auditVerification.remotePending, coverageGaps: [...new Set(auditEvents.flatMap((event) => event.coverage.gaps))] },
    readyTransitions,
  };
  return { governance, diagnostics, flow, state, transitionRequirements, resources };
}

export async function terminalGovernanceBlocks(
  project: ProjectContext,
  control: ResolvedControlPlane,
): Promise<string[]> {
  const { governance, flow } = control;
  const blocks: string[] = [];
  if (governance.currentStage !== 'ready-to-archive') blocks.push('transition:ready-to-archive');
  const readyReceipt = governance.transitions.at(-1);
  if (!readyReceipt || readyReceipt.to !== 'ready-to-archive') {
    blocks.push('transition:ready-receipt-missing');
  } else {
    if (readyReceipt.contentRevision !== governance.revision.contentRevision || readyReceipt.policySnapshotDigest !== governance.revision.policySnapshotDigest || readyReceipt.gitHead !== governance.revision.gitHead) {
      blocks.push('transition:ready-receipt-stale');
    }
    const sourceStage = flow.stages.find((stage) => stage.id === readyReceipt.from);
    const sourceExit = sourceStage ? structuredExit(sourceStage) : {};
    for (const gateId of [...new Set([...(sourceStage?.gates ?? []), ...(sourceExit.gates ?? [])])]) {
      const evidence = await readGateEvidence(project, control.state.id, gateId, control.resources);
      const boundToTransition = Boolean(evidence && readyReceipt.gates.includes(evidence.digest) && evidence.stateRevision === readyReceipt.stateRevisionBefore);
      const boundToArchiveRecheck = Boolean(evidence && evidence.stateRevision === governance.revision.stateRevision);
      if (!evidence || evidence.status !== 'passed' || (!boundToTransition && !boundToArchiveRecheck) ||
        evidence.policySnapshotDigest !== governance.revision.policySnapshotDigest || evidence.gitHead !== governance.revision.gitHead) {
        blocks.push(`gate:${gateId}:missing-or-stale`);
      }
    }
  }
  for (const policyId of flow.terminal.archive.approvals ?? []) {
    const policy = policyById(flow, policyId);
    if (!policy) { blocks.push(`approval-policy:${policyId}:missing`); continue; }
    const result = approvalsForPolicy(governance.approvals, policy, 'archive', governance.revision.stateRevision);
    if (result.rejected) blocks.push(`approval:${policyId}:rejected`);
    if (result.missing > 0 || !result.separationSatisfied) blocks.push(`approval:${policyId}:missing-${result.missing || 'separation'}`);
  }
  const policy = flow.terminal.archive.auditPolicy ?? flow.governance?.audit;
  const remoteRequired = policy?.remoteDelivery === 'required' || Boolean(project.manifest.audit?.remote?.requiredFor.includes(flow.policy.assuranceLevel));
  const events = (await readAuditEvents(project)).filter((event) => event.change === control.state.id);
  for (const type of policy?.requiredEventTypes ?? []) if (!events.some((event) => event.eventType === type)) blocks.push(`audit:${type}:missing`);
  if (!governance.audit.chainValid) blocks.push('audit:chain-invalid');
  if (policy?.runtimeCoverage === 'required' && governance.audit.coverageGaps.length > 0) blocks.push('audit:runtime-coverage-gap');
  if (remoteRequired && governance.audit.remotePending > 0) blocks.push('audit:remote-pending');
  if (remoteRequired && !project.manifest.audit?.remote) blocks.push('audit:remote-not-configured');
  return [...new Set(blocks)];
}
