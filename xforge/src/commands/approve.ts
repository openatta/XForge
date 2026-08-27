import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { ApprovalPolicy, ApprovalReceipt, Diagnostic, FileChange, NextAction, ProjectContext } from '../types.js';
import { recordAudit } from '../core/audit.js';
import { resolveControlPlane, type ResolvedControlPlane } from '../core/control-plane.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { atomicWrite } from '../core/files.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { sha256, stableStringify } from '../core/hash.js';
import { assertManaged } from '../core/project-loader.js';
import { safeResolve } from '../core/path-safety.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { approvalReceiptDigest } from '../core/approval-receipt.js';
import { pollApproval, submitApprovalRequest, withMcpApprovalSession } from '../core/mcp-approval.js';

/**
 * An approval is evidence about a moment, so it is not valid forever.
 *
 * This is the default lifetime for every receipt this command writes, whichever mechanism produced
 * it. A local receipt always gets it. An mcp receipt gets it only when the provider did not state
 * its own `expiresAt`: without this, a provider that simply omits the field would produce an
 * approval that never expires (control-plane.ts treats an absent `expiresAt` as unbounded), so
 * forgetting one optional field would buy a stronger receipt than the local path can issue.
 */
export const APPROVAL_LIFETIME_HOURS = 168;

/** The default expiry stamped on a receipt, `APPROVAL_LIFETIME_HOURS` from now. */
function approvalExpiry(): string {
  return new Date(Date.now() + APPROVAL_LIFETIME_HOURS * 3_600_000).toISOString();
}

/**
 * The live terminal the CLI uses to obtain an approval decision.
 *
 * The decision must be produced by this dialogue, never by argv: `--decision approve --attestation
 * human` on the command line is a caller stating its own conclusion, which is not evidence of
 * anything. `cli.ts` supplies an implementation over this process's own stdin (prompts go to
 * stderr), gated on both stdin and stdout being TTYs. Be exact about what that gate shows: the
 * command ran in an interactive session and something answered the questions. It does not show that
 * a human answered them — a pty satisfies `isTTY` and can drive the prompts just as well. XForge
 * does not open `/dev/tty`, and opening it would not close that gap either. Omitting the terminal
 * makes a local approval impossible.
 */
export interface ApprovalTerminal {
  /** Shows context. Never returns input. */
  present(message: string): Promise<void> | void;
  /** Writes the prompt and returns exactly what the human typed. */
  question(prompt: string): Promise<string>;
}

interface ApproveOptions {
  change: string;
  transition: string;
  policy?: string;
  actor?: string;
  role?: string;
  reason?: string;
  decision?: 'approve' | 'reject';
  /** Intent hint only. Nothing a caller passes here is ever copied onto a receipt. */
  attestation?: 'human';
  provider?: string;
  interactive: boolean;
  dryRun: boolean;
  /** Required for local approvals; supplied by the CLI, absent for programmatic callers. */
  terminal?: ApprovalTerminal;
}

interface ApproveResult {
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

/**
 * Refuses a `--for` that cannot produce a receipt anything will count.
 *
 * An approval is an irreversible draw on a human being. XForge is careful in one direction — the
 * decision may not be constituted by flags, `architectureDeltas` demands a named `decidedBy`, Gate
 * Evidence is written only by the runner — all of it aimed at an Agent manufacturing an authorisation
 * nobody gave. The opposite direction was unguarded, and it has the same end state: a governance
 * record that disagrees with the governance state.
 *
 * A live run wrote `--for stage`, taking the word from this command's own usage string. It was
 * accepted. Two real people were called in, each signed once, and both receipts were filed under a
 * transition the Flow does not contain, so `state` still reported `missing: 2` with four receipts on
 * disk under two different transitions and nothing to say which pair was the real one. The correct
 * value had been sitting in `state.nextActions[].command` the whole time.
 *
 * So the rule is: before a receipt is written, the transition it names must be one this Change could
 * actually take, and some policy must gate it. A rework target passes the first test and fails the
 * second — nothing governs a step backwards — and a receipt filed against one is just as uncountable
 * as `--for stage` was.
 */
function assertApprovableTransition(control: ResolvedControlPlane, options: ApproveOptions, flow: any): void {
  const stage = control.governance.currentStage;
  const candidates = [...control.transitionRequirements.keys()];
  const archiveApprovals: string[] = stage === 'ready-to-archive' ? flow.terminal?.archive?.approvals ?? [] : [];
  const approvable = [
    ...candidates.filter((target) => (control.transitionRequirements.get(target)?.approvalPolicies.length ?? 0) > 0),
    ...(archiveApprovals.length > 0 ? ['archive'] : []),
  ];
  const suggestion = approvable[0];
  const correction = suggestion
    ? ` Use --for ${suggestion}${approvable.length > 1 ? ` (or one of: ${approvable.join(', ')})` : ''}.`
    : ' No transition out of this Stage requires an approval right now.';
  const nextActions: NextAction[] = [{
    action: 'resolve-approval-transition', actor: 'main',
    reason: `Read the exact command from state.nextActions[] rather than assembling one from the usage string: xforge state --change ${options.change} reports the transition each pending approval belongs to.`,
    command: ['xforge', 'state', '--change', options.change],
  }];

  if (options.transition === 'archive') {
    if (archiveApprovals.length > 0) return;
    throw new XForgeError(diagnostic(
      'XFORGE_APPROVAL_TRANSITION_UNAPPROVABLE',
      `--for archive is not approvable here: this Change is at Stage ${stage}, and archive approval is only collected at ready-to-archive.${correction}`,
    ), { nextActions });
  }
  if (!candidates.includes(options.transition)) {
    throw new XForgeError(diagnostic(
      'XFORGE_APPROVAL_TRANSITION_UNKNOWN',
      `--for ${options.transition} does not name a transition this Change can take: from Stage ${stage} the Flow allows ${candidates.length > 0 ? candidates.join(', ') : 'no transition at all'}. "--for" takes the id of the transition the approval unlocks, never a literal word like "stage".${correction} Nothing was recorded.`,
    ), { nextActions });
  }
  if ((control.transitionRequirements.get(options.transition)?.approvalPolicies.length ?? 0) === 0) {
    throw new XForgeError(diagnostic(
      'XFORGE_APPROVAL_TRANSITION_UNAPPROVABLE',
      `The transition to ${options.transition} is legal from ${stage} but no approval policy gates it, so a receipt recorded against it would never be counted — a human decision filed where nothing reads it.${correction} Nothing was recorded.`,
    ), { nextActions });
  }
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
 * Obtains the decision from whoever is at the terminal.
 *
 * Flags may pre-fill identity and reason, but the decision word itself must be typed live — a caller
 * that only stuffs argv never reaches these questions at all (see the `interactive`/`terminal` gate
 * in `executeApprove`), so it cannot produce a local approval. There is no code to type back: the
 * live dialogue is the evidence, and it is evidence of an interactive session rather than of a
 * particular person. A pty that answers these prompts produces a receipt identical to a typed one,
 * and the receipt's `approver.id` is whatever was entered, not a verified identity.
 *
 * Alongside the dialogue, `executeApprove` appends a matching `approval.decided` event to this
 * Change's audit hash chain in the same run, and a later read cross-checks the receipt against that
 * chain (`approvalVerifiedInChain`) rather than against a value the approver retyped. Be honest
 * about the strength of that too: the chain is an unkeyed SHA-256 over public inputs, stored in the
 * repository the governed Agent can write. It reliably catches a receipt that was never decided
 * through this command — a hand-placed file, a corrupted or truncated log — and it does not
 * withstand an actor who rewrites the chain and the receipt together. That is corruption-evidence,
 * not tamper-evidence.
 *
 * So the local mechanism is honest-agent governance: it makes an unattended self-approval a
 * deliberate, recorded act instead of an accident, and it is trustworthy to the degree the
 * operator's environment is. A policy that needs more than that should not list `local` in its
 * providers at all; it should require an mcp provider, where the decision is made by a system whose
 * secret and endpoint sit outside the tree the Agent can reach.
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
  assertApprovableTransition(control, options, resolved.flow);
  const policy = approvalPolicy(resolved.flow, control.governance.currentStage, options.transition, options.policy);
  const revision = control.governance.revision;
  let receipt: ApprovalReceipt;
  let mcpDiagnostics: Diagnostic[] = [];

  if (!options.dryRun) await recordAudit(project, { eventType: 'approval.requested', change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage, revision, decision: policy.id, outcome: 'succeeded' });

  if (options.provider) {
    /*
     * `--provider local` is the one wrong argument this command can be sure it understands.
     *
     * `local` is a provider in a policy's `providers` list, so it is a real name and it appears in
     * the policy — but it is not an entry in `manifest.approvals.providers`, because terminal
     * approval has no server to declare. Resolved through the lookup below it came back "not
     * authorized", pointed at `doctor`, and sent a reader looking for a configuration gap that does
     * not exist. The route they wanted is one flag shorter than the one they typed.
     */
    if (options.provider === 'local') throw new XForgeError(diagnostic(
      'XFORGE_APPROVAL_PROVIDER_FORBIDDEN',
      'Terminal approval takes no --provider. Run the same command without it: --provider names an MCP provider declared under manifest.yaml\'s approvals.providers, and local approval is what happens in its absence.',
    ), {
      nextActions: [{
        action: 'approve-at-the-terminal',
        reason: 'The policy allows local approval, which is the interactive terminal dialogue this command runs when no --provider is given.',
        actor: 'human',
        command: ['xforge', 'approve', '--change', options.change, '--for', options.transition],
      }],
    });
    const provider = project.manifest.approvals?.providers.find((item) => item.id === options.provider);
    if (!provider) throw new XForgeError(diagnostic('XFORGE_APPROVAL_PROVIDER_FORBIDDEN', `Approval provider is not authorized: ${options.provider}.`), {
      nextActions: [{ action: 'resolve-approval-provider', reason: `"${options.provider}" is not declared under manifest.yaml's approvals.providers. Check the provider id, or run xforge doctor to list approval-provider configuration gaps.`, actor: 'human', command: ['xforge', 'doctor'] }],
    });
    if (!policy.providers.includes(provider.id)) throw new XForgeError(diagnostic('XFORGE_APPROVAL_PROVIDER_FORBIDDEN', `Policy ${policy.id} does not allow provider ${provider.id}.`), {
      nextActions: [{ action: 'resolve-approval-provider', reason: `Policy ${policy.id} only allows: ${policy.providers.join(', ') || '(none)'}. Either use one of those providers or add "${provider.id}" to the policy's providers list in the Flow definition.`, actor: 'human' }],
    });
    const server = resources.mcpServers.get(provider.mcpServer);
    if (!server) throw new XForgeError(diagnostic('XFORGE_APPROVAL_MCP_SERVER_MISSING', `McpServer resource is missing or not enabled: ${provider.mcpServer}.`), {
      nextActions: [{ action: 'resolve-approval-provider', reason: `Approval provider "${provider.id}" references McpServer "${provider.mcpServer}", which is not registered or not enabled in the manifest. Register it under mcp-servers/, or reconfigure the policy to use an available provider.`, actor: 'human', command: ['xforge', 'doctor'] }],
    });
    const governingDigest = sha256(stableStringify({ change: options.change, flow: resolved.flow.metadata.name, policy: policy.id, revision }));
    const resumeCommand = ['xforge', 'approve', '--change', options.change, '--for', options.transition, '--policy', policy.id, '--provider', provider.id];
    /*
     * The same line the local path draws, in the same place: everything decidable without troubling
     * anyone has been decided, and the next step reaches a person. Submitting the request under
     * `--dry-run` would have raised a real approval task on a real external system for a run whose
     * whole purpose is to not do that.
     */
    if (options.dryRun) {
      return {
        data: { change: options.change, policy: policy.id, transition: options.transition, receipt: null, dryRun: true, status: 'pending' },
        diagnostics: [
          ...resources.diagnostics,
          ...control.diagnostics,
          diagnostic(
            'XFORGE_APPROVAL_DRY_RUN_VALID',
            `This approval is well-formed: policy ${policy.id} gates the transition to ${options.transition} from Stage ${control.governance.currentStage}, provider ${provider.id} is authorized for it, and a receipt recorded here would be counted. No request was submitted to the provider.`,
            undefined,
            /*
             * `info`, not `warning`. Nothing is wrong here — this is the rehearsal reporting that it
             * found nothing wrong — and a warning on the one command an Agent runs *to be careful*
             * teaches the reader that this command's warnings can be ignored. The actionable half
             * (the exact command to re-run) is carried by the `collect-approval` next action below,
             * so a host that filters `info` out of what it shows a person loses no instruction.
             */
            'info',
          ),
        ],
        changes: [],
        nextActions: [{
          action: 'collect-approval', type: 'approval', id: policy.id, status: 'pending', actor: 'human',
          reason: `Re-run without --dry-run to submit the request to ${provider.id} and poll for the decision.`,
          command: resumeCommand,
        }],
      };
    }
    const { result: poll, diagnostics: envDiagnostics } = await withMcpApprovalSession(project, server.value, provider.id, async (client, timeoutMs) => {
      await submitApprovalRequest(client, timeoutMs, {
        change: options.change, flow: resolved.flow.metadata.name, stage: control.governance.currentStage, transition: options.transition, policyId: policy.id,
        revision, governingDigest, roles: policy.roles, reason: options.reason ?? '',
      });
      return pollApproval(client, timeoutMs, governingDigest);
    });
    mcpDiagnostics = envDiagnostics;
    if (poll.status === 'pending') {
      /*
       * A pending external decision is a state of the world, not a failure of this command: an
       * Agent caller gets a successful envelope carrying a pending next action instead of an error
       * it has to pattern-match. Nothing is written either way.
       */
      return {
        data: { change: options.change, policy: policy.id, transition: options.transition, receipt: null, dryRun: options.dryRun, status: 'pending' },
        diagnostics: [...resources.diagnostics, ...control.diagnostics, ...mcpDiagnostics],
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
      decidedAt: new Date().toISOString(), reason: poll.reason,
      /* The provider's own expiry wins when it states one (`narrowPoll` has already rejected the
         response outright unless it is an RFC 3339 date-time); otherwise the same default lifetime
         the local path uses applies, so an omitted field cannot buy a receipt that outlives every
         other kind. */
      expiresAt: poll.expiresAt ?? approvalExpiry(),
    };
    receipt = { ...unsigned, digest: approvalReceiptDigest({ ...unsigned, digest: '' }) };
  } else {
    /*
     * Local approval. `--attestation human` is only an intent hint: neither the flag nor the `isTTY`
     * gate proves a human decided, since an Agent session runs on a TTY too. The CLI therefore takes
     * identity, decision, and reason from the live terminal dialogue and sets the attestation itself
     * rather than accepting one from the caller, and there is no receipt-file-import path at all.
     * Read `attestation.method: 'cli-terminal'` as "this decision arrived through the CLI's terminal
     * dialogue", never as "a human was verified" — the field records the mechanism, not an identity
     * check. What the receipt is worth later rests on the matching `approval.decided` event this same
     * run appends to the Change's audit chain (`approvalVerifiedInChain`), with the limits of that
     * chain spelled out above `collectLocalDecision`.
     */
    if (!policy.providers.includes('local')) throw new XForgeError(diagnostic('XFORGE_APPROVAL_PROVIDER_FORBIDDEN', `Policy ${policy.id} does not allow local approvals.`), {
      nextActions: [{ action: 'resolve-approval-provider', reason: `Policy ${policy.id} requires an external provider (${policy.providers.join(', ') || '(none configured)'}) and does not permit a human to approve at the terminal. If the declared provider's McpServer is a placeholder or unreachable, this is a configuration gap, not a pending decision — tell the user rather than retrying. Fixing it requires editing the Flow/manifest to register a working provider or add "local" to this policy's providers, not a CLI command.`, actor: 'human' }],
    });
    /*
     * A dry run stops here, and stops here whether or not a terminal is attached.
     *
     * Both orderings were wrong before. Without a terminal, this command died on the interactivity
     * gate below before reporting anything about the arguments, so the one tool available for
     * checking an approval command in advance could not check it — which is precisely how a wrong
     * `--for` reached two real approvers. With a terminal, it was worse: `--dry-run` ran the whole
     * dialogue, asked a human for a decision, and then discarded it, because only the write is
     * skipped when `dryRun` is set. Everything that can be decided without a human has now been
     * decided above; the remaining step *is* the human, and a rehearsal must not spend one.
     */
    if (options.dryRun) {
      return {
        data: { change: options.change, policy: policy.id, transition: options.transition, receipt: null, dryRun: true, status: 'pending' },
        diagnostics: [
          ...resources.diagnostics,
          ...control.diagnostics,
          diagnostic(
            'XFORGE_APPROVAL_DRY_RUN_VALID',
            `This approval is well-formed: policy ${policy.id} gates the transition to ${options.transition} from Stage ${control.governance.currentStage}, and a receipt recorded here would be counted. Nothing was written, and no decision was requested. Re-run without --dry-run at an interactive terminal to collect it.`,
            undefined,
            /* See the mcp path above: informational by nature, so `info` rather than `warning`. */
            'info',
          ),
        ],
        changes: [],
        nextActions: [{
          action: 'collect-approval', type: 'approval', id: policy.id, status: 'pending', actor: 'human',
          reason: `Policy ${policy.id} requires ${policy.minApprovers} approver(s) with role ${policy.roles.join(' | ')}. The decision is typed at the terminal; it cannot be supplied by a flag.`,
          command: ['xforge', 'approve', '--change', options.change, '--for', options.transition, '--policy', policy.id],
        }],
      };
    }
    if (!options.interactive || !options.terminal) {
      throw new XForgeError(diagnostic(
        'XFORGE_APPROVAL_INTERACTIVE_REQUIRED',
        'Local approval requires an interactive terminal: XForge asks for the approver, the decision, and the reason on stdin, and command-line flags cannot constitute the decision. There is no manifest setting that relaxes this. For a non-interactive session, use an mcp provider instead. To check the command itself without a terminal, re-run it with --dry-run.',
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
      expiresAt: approvalExpiry(),
      attestation: { method: 'cli-terminal' as const, respondedAt: decided.respondedAt },
    };
    receipt = { ...unsigned, digest: approvalReceiptDigest({ ...unsigned, digest: '' }) };
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
      /*
       * `approvalVerifiedInChain` trusts a receipt only once a matching `approval.decided` event is
       * in the chain (see the comment above `collectLocalDecision`), so a receipt written without
       * that event is a human decision the system can never treat as valid. Removing it here means a
       * retry redoes the whole decision cleanly instead of leaving an unusable, undead receipt file.
       */
      await rm(await safeResolve(project.root, target), { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return {
    data: { change: options.change, policy: policy.id, transition: options.transition, receipt: options.dryRun ? null : receipt, dryRun: options.dryRun, status: 'recorded' },
    diagnostics: [...resources.diagnostics, ...control.diagnostics, ...mcpDiagnostics],
    changes,
  };
}
