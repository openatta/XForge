import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalPolicy, ApprovalReceipt, Diagnostic, FileChange, NextAction, ProjectContext } from '../types.js';
import { approvalVerifiedInChain, recordAudit } from '../core/audit.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite, readJsonIfExists, rollbackWrittenFile } from '../core/files.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { sha256, stableStringify } from '../core/hash.js';
import { safeResolve } from '../core/path-safety.js';
import { assertManaged } from '../core/project-loader.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { approvalReceiptDigest } from '../core/approval-receipt.js';
import { pollApproval, submitApprovalRequest, withMcpApprovalSession } from '../core/mcp-approval.js';

/** A local approval is repository-level evidence about a moment, so it is not valid forever. */
export const LOCAL_APPROVAL_LIFETIME_HOURS = 168;

/**
 * The live terminal the CLI uses to obtain a human decision.
 *
 * The decision must be produced by this dialogue, never by argv: an Agent runs inside a TTY, so
 * `--decision approve --attestation human` on the command line is not evidence that a human decided
 * anything. `cli.ts` supplies an implementation bound to the controlling terminal (`/dev/tty` when
 * available, otherwise stdin/stderr); omitting it makes a local approval impossible.
 */
export interface ApprovalTerminal {
  /** Shows context. Never returns input. */
  present(message: string): Promise<void> | void;
  /** Writes the prompt and returns exactly what the human typed. */
  question(prompt: string): Promise<string>;
}

export interface ApproveOptions {
  change: string;
  transition: string;
  policy?: string;
  actor?: string;
  role?: string;
  reason?: string;
  decision?: 'approve' | 'reject';
  /** Intent hint only. It can never satisfy the human-attestation requirement by itself. */
  attestation?: 'human';
  provider?: string;
  interactive: boolean;
  dryRun: boolean;
  /** Required for local approvals; supplied by the CLI, absent for programmatic callers. */
  terminal?: ApprovalTerminal;
}

export interface ApproveResult {
  data: {
    change: string;
    policy: string;
    transition: string;
    receipt: ApprovalReceipt | null;
    dryRun: boolean;
    status?: 'recorded' | 'pending';
  };
  diagnostics: Diagnostic[];
  changes: FileChange[];
  nextActions?: NextAction[];
}

function exitApprovals(flow: any, stageId: string): string[] {
  const exit = flow.stages.find((stage: any) => stage.id === stageId)?.exit;
  return Array.isArray(exit?.approvals) ? exit.approvals : [];
}

function approvalPolicy(flow: any, stageId: string, transition: string, requested?: string): ApprovalPolicy {
  const ids = transition === 'archive' ? flow.terminal.archive.approvals ?? [] : exitApprovals(flow, stageId);
  const selected = requested ?? (ids.length === 1 ? ids[0] : null);
  if (!selected || !ids.includes(selected)) throw new XForgeError(diagnostic('XFORGE_APPROVAL_POLICY_REQUIRED', `Approval policy must be one of: ${ids.join(', ') || '(none)'}.`));
  const policy = flow.governance?.approvalPolicies.find((item: ApprovalPolicy) => item.id === selected);
  if (!policy) throw new XForgeError(diagnostic('XFORGE_APPROVAL_POLICY_MISSING', `Approval policy is not defined: ${selected}.`));
  return policy;
}

async function ask(terminal: ApprovalTerminal, prompt: string, suggestion?: string): Promise<string> {
  const answer = (await terminal.question(suggestion ? `${prompt} [${suggestion}]: ` : `${prompt}: `)).trim();
  return answer.length > 0 ? answer : (suggestion ?? '');
}

interface LocalDecision {
  actor: string;
  role: string;
  reason: string;
  decision: 'approve' | 'reject';
  respondedAt: string;
}

/**
 * Obtains the decision from the human at the terminal.
 *
 * Flags may pre-fill identity and reason, but the decision word itself must be typed live at the
 * terminal — a caller that only stuffs argv never reaches this function's questions at all (see the
 * `interactive`/`terminal` gate in `executeApprove`), so it cannot produce a local approval. There is
 * no code to type back: the live dialogue is the evidence. What makes the resulting receipt trustworthy
 * is not anything on the receipt itself, but that `executeApprove` records a matching `approval.decided`
 * event in this Change's audit hash chain in the same run — a later read cross-checks the receipt
 * against that chain (see `approvalVerifiedInChain`) rather than against a value the human retyped.
 */
async function collectLocalDecision(
  terminal: ApprovalTerminal,
  policy: ApprovalPolicy,
  context: { change: string; flow: string; stage: string; transition: string; governingRevision: string },
  options: ApproveOptions,
): Promise<LocalDecision> {
  await terminal.present([
    '',
    'XForge local approval — the decision below is recorded as a human attestation.',
    `  Change      : ${context.change}`,
    `  Flow/Stage  : ${context.flow} / ${context.stage}`,
    `  Transition  : ${context.transition}`,
    `  Policy      : ${policy.id} (roles: ${policy.roles.join(', ')}; approvers required: ${policy.minApprovers})`,
    `  Governing   : ${context.governingRevision}`,
    '',
  ].join('\n'));

  const actor = await ask(terminal, 'Approver identity', options.actor);
  if (!actor) throw new XForgeError(diagnostic('XFORGE_APPROVAL_FIELDS_REQUIRED', 'An approver identity is required.'));
  const role = await ask(terminal, `Approver role (${policy.roles.join(' | ')})`, options.role);
  if (!policy.roles.includes(role)) throw new XForgeError(diagnostic('XFORGE_APPROVAL_ROLE_FORBIDDEN', `Approver role is not authorized: ${role || '(none)'}.`));
  /* Never defaulted from argv: the decision itself must be typed. */
  const decision = (await ask(terminal, 'Decision (approve | reject)')).toLowerCase();
  if (decision !== 'approve' && decision !== 'reject') {
    throw new XForgeError(diagnostic('XFORGE_APPROVAL_DECISION_REQUIRED', 'The decision must be typed as approve or reject at the terminal.'));
  }
  const reason = await ask(terminal, 'Reason', options.reason);
  if (!reason) throw new XForgeError(diagnostic('XFORGE_APPROVAL_FIELDS_REQUIRED', 'A reason is required.'));
  return { actor, role, reason, decision, respondedAt: new Date().toISOString() };
}

export async function executeApprove(project: ProjectContext, options: ApproveOptions): Promise<ApproveResult> {
  assertManaged(project, 'approve');
  const resolved = await resolveChangeState(project, options.change);
  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) throw new XForgeError(diagnostic('XFORGE_GOVERNANCE_FLOW_REQUIRED', 'approve requires a Protocol 2 governed Flow.'));
  const resources = await loadSelectedResources(project);
  const control = await resolveControlPlane(project, options.change, resolved.flow, resolved.state, resources, resolved.config);
  const policy = approvalPolicy(resolved.flow, control.governance.currentStage, options.transition, options.policy);
  const revision = control.governance.revision;
  let receipt: ApprovalReceipt;

  if (!options.dryRun) await recordAudit(project, { eventType: 'approval.requested', change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage, revision, decision: policy.id, outcome: 'succeeded' });

  if (options.provider) {
    const provider = project.manifest.approvals?.providers.find((item) => item.id === options.provider);
    if (!provider) {
      throw new XForgeError(
        diagnostic('XFORGE_APPROVAL_PROVIDER_FORBIDDEN', `Approval provider is not authorized: ${options.provider}.`),
        { nextActions: [{ action: 'declare-approval-provider', type: 'approval', actor: 'human', reason: `Declare provider ${options.provider} under approvals.providers in xforge/manifest.yaml (mcpServer, roles), or re-run without --provider to select from the policy's own list.`, command: ['xforge', 'doctor'] }] },
      );
    }
    if (!policy.providers.includes(provider.id)) {
      throw new XForgeError(
        diagnostic('XFORGE_APPROVAL_PROVIDER_FORBIDDEN', `Policy ${policy.id} does not allow provider ${provider.id}.`),
        { nextActions: [{ action: 'select-allowed-provider', type: 'approval', actor: 'human', reason: `Policy ${policy.id} allows: ${policy.providers.join(', ') || '(none)'}. Pick one of these, or add the provider to the policy in the Flow definition and re-check the Change.` }] },
      );
    }
    const server = resources.mcpServers.get(provider.mcpServer);
    if (!server) {
      throw new XForgeError(
        diagnostic('XFORGE_APPROVAL_MCP_SERVER_MISSING', `McpServer resource is missing or not enabled: ${provider.mcpServer}.`),
        { nextActions: [{ action: 'configure-mcp-server', type: 'approval', actor: 'human', reason: `Enable the ${provider.mcpServer} McpServer resource in xforge/manifest.yaml (see scaffold/mcp-servers/enterprise-approvals.yaml) and run xforge install, or approve locally on the terminal. This is a configuration gap, not a pending decision — fix it rather than retrying.`, command: ['xforge', 'doctor'] }] },
      );
    }
    const governingDigest = sha256(stableStringify({ change: options.change, flow: resolved.flow.metadata.name, policy: policy.id, revision }));
    const resumeCommand = ['xforge', 'approve', '--change', options.change, '--for', options.transition, '--policy', policy.id, '--provider', provider.id];
    const poll = await withMcpApprovalSession(project, server.value, provider.id, async (client, timeoutMs) => {
      await submitApprovalRequest(client, timeoutMs, {
        change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage, transition: options.transition, policyId: policy.id,
        revision, governingDigest, roles: policy.roles, reason: options.reason ?? '',
      });
      return pollApproval(client, timeoutMs, governingDigest);
    });
    if (poll.status === 'pending') {
      /*
       * A pending external decision is a state of the world, not a failure of this command: an
       * Agent caller gets a successful envelope carrying a pending next action instead of an error
       * it has to pattern-match. Nothing is written either way.
       */
      return {
        data: { change: options.change, policy: policy.id, transition: options.transition, receipt: null, dryRun: options.dryRun, status: 'pending' },
        diagnostics: [...resources.diagnostics, ...control.diagnostics],
        changes: [],
        nextActions: [{
          action: 'await-approval', type: 'approval', id: policy.id, status: 'pending', actor: 'human',
          reason: `Approval request for policy ${policy.id} is still pending on provider ${provider.id}. Nothing was recorded; re-run once a decision is available.`,
          command: resumeCommand,
        }],
      };
    }
    if (!provider.roles.includes(poll.approver.role) || !policy.roles.includes(poll.approver.role)) {
      throw new XForgeError(diagnostic('XFORGE_APPROVAL_ROLE_FORBIDDEN', `Approver role is not authorized: ${poll.approver.role}.`));
    }
    const unsigned = {
      apiVersion: 'xforge.dev/v1alpha2' as const, kind: 'ApprovalReceipt' as const, receiptId: randomUUID(), change: options.change,
      flow: resolved.flow.metadata.name, stage: control.governance.currentStage, transition: options.transition, policyId: policy.id,
      stateRevision: revision.stateRevision, contentRevision: revision.contentRevision,
      policySnapshotDigest: revision.policySnapshotDigest, gitBase: revision.gitBase, gitHead: revision.gitHead,
      governingDigest, governingRevision: revision.governingRevision!,
      decision: poll.decision, approver: { id: poll.approver.id, provider: provider.id, role: poll.approver.role, type: 'external-system' as const },
      decidedAt: new Date().toISOString(), reason: poll.reason, ...(poll.expiresAt ? { expiresAt: poll.expiresAt } : {}),
    };
    receipt = { ...unsigned, digest: approvalReceiptDigest({ ...unsigned, digest: '' }) };
  } else {
    /*
     * Local approval. `--attestation human` is only an intent hint: an Agent session runs on a TTY,
     * so neither the flag nor `isTTY` proves a human decided. The CLI therefore obtains the identity,
     * the decision, and the reason from the live terminal itself and sets the human attestation
     * itself — there is no receipt-file-import path and nothing on the receipt is retyped as proof;
     * what makes it trustworthy later is that this same run also appends a matching `approval.decided`
     * event to the Change's audit hash chain (see `approvalVerifiedInChain`).
     */
    if (!policy.providers.includes('local')) {
      throw new XForgeError(
        diagnostic('XFORGE_APPROVAL_PROVIDER_FORBIDDEN', `Policy ${policy.id} does not allow local approvals.`),
        { nextActions: [{ action: 'resolve-approval-provider', type: 'approval', actor: 'human', reason: `Policy ${policy.id} requires an external provider (${policy.providers.join(', ') || '(none configured)'}) and does not permit a human to approve at the terminal. If the declared provider's McpServer is a placeholder or unreachable, this is a configuration gap, not a pending decision — tell the user rather than retrying. Fixing it requires editing the Flow/manifest to register a working provider or add "local" to this policy's providers, not a CLI command.` }] },
      );
    }
    if (!options.interactive || !options.terminal) {
      throw new XForgeError(diagnostic(
        'XFORGE_APPROVAL_INTERACTIVE_REQUIRED',
        'Local approval requires an interactive terminal: XForge asks for the approver, the decision, and the reason on stdin. Command-line flags cannot constitute the decision. Use an mcp provider in non-interactive mode.',
      ));
    }
    const governingDigest = sha256(stableStringify({ change: options.change, flow: resolved.flow.metadata.name, policy: policy.id, revision }));
    const decided = await collectLocalDecision(options.terminal, policy, {
      change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage,
      transition: options.transition, governingRevision: revision.governingRevision!,
    }, options);
    const unsigned = {
      apiVersion: 'xforge.dev/v1alpha2' as const, kind: 'ApprovalReceipt' as const, receiptId: randomUUID(), change: options.change,
      flow: resolved.flow.metadata.name, stage: control.governance.currentStage, transition: options.transition, policyId: policy.id,
      stateRevision: revision.stateRevision, contentRevision: revision.contentRevision,
      policySnapshotDigest: revision.policySnapshotDigest, gitBase: revision.gitBase, gitHead: revision.gitHead,
      governingDigest, governingRevision: revision.governingRevision!,
      decision: decided.decision, approver: { id: decided.actor, provider: 'local', role: decided.role, type: 'human' as const },
      decidedAt: new Date().toISOString(), reason: decided.reason,
      expiresAt: new Date(Date.now() + LOCAL_APPROVAL_LIFETIME_HOURS * 3_600_000).toISOString(),
      attestation: { method: 'cli-terminal' as const, respondedAt: decided.respondedAt },
    };
    receipt = { ...unsigned, digest: approvalReceiptDigest({ ...unsigned, digest: '' }) };
  }

  /*
   * Idempotency: the same approver re-approving the same policy revision returns the already
   * recorded receipt instead of writing a duplicate (minApprovers counts distinct humans, so the
   * match is per approver, never per policy alone). A matched receipt the chain does not attest is
   * a crash remnant — the write succeeded but the audit record did not — and is removed so the
   * fresh decision replaces it cleanly.
   */
  if (!options.dryRun) {
    const approvalsDir = await safeResolve(project.root, `${project.changesPath}/${options.change}/approvals/${policy.id}`);
    for (const name of await readdir(approvalsDir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const relative = `${project.changesPath}/${options.change}/approvals/${policy.id}/${name}`;
      const existing = await readJsonIfExists<ApprovalReceipt>(path.join(approvalsDir, name));
      if (!existing || existing.governingDigest !== receipt.governingDigest) continue;
      if (existing.approver.id !== receipt.approver.id || existing.approver.provider !== receipt.approver.provider) continue;
      if (await approvalVerifiedInChain(project, options.change, policy.id, existing.digest)) {
        return {
          data: { change: options.change, policy: policy.id, transition: options.transition, receipt: existing, dryRun: false, status: 'recorded' },
          diagnostics: [...resources.diagnostics, ...control.diagnostics],
          changes: [],
        };
      }
      await rollbackWrittenFile(project.root, relative);
    }
  }

  /*
   * Ingestion binding. New receipts are bound by governing revision, so a commit or a later Stage's
   * Evidence between the decision and its import does not reject the human decision. Receipts from
   * providers that predate the governing revision keep the original exact-state binding.
   */
  const boundToRevision = receipt.governingRevision
    ? receipt.governingRevision === revision.governingRevision
    : receipt.stateRevision === revision.stateRevision && receipt.contentRevision === revision.contentRevision
      && receipt.policySnapshotDigest === revision.policySnapshotDigest;
  if (receipt.change !== options.change || receipt.flow !== resolved.flow.metadata.name || receipt.stage !== control.governance.currentStage || receipt.transition !== options.transition || receipt.policyId !== policy.id || !boundToRevision) {
    throw new XForgeError(diagnostic('XFORGE_APPROVAL_STALE', 'Approval receipt is not bound to the current Change, Flow, Stage, policy, and governing revision.'));
  }
  const target = `${project.changesPath}/${options.change}/approvals/${policy.id}/${receipt.receiptId}.json`;
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  const changes: FileChange[] = [{ action: 'create', path: target, digest: sha256(content), source: `approval:${policy.id}` }];
  if (!options.dryRun) {
    await atomicWrite(project.root, target, content);
    try {
      await recordAudit(project, { eventType: 'approval.decided', change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage, revision, decision: receipt.decision, reason: receipt.reason, outcome: receipt.decision === 'approve' ? 'succeeded' : 'denied', input: { policy: policy.id, receipt: receipt.digest } });
    } catch (error) {
      /* A receipt the chain never attests must not stay: control-plane refuses it anyway, and its
         presence would mislead `xforge state` into reporting an approval that does not count. */
      await rollbackWrittenFile(project.root, target);
      throw error;
    }
  }
  return {
    data: { change: options.change, policy: policy.id, transition: options.transition, receipt: options.dryRun ? null : receipt, dryRun: options.dryRun, status: 'recorded' },
    diagnostics: [...resources.diagnostics, ...control.diagnostics],
    changes,
  };
}
