import type { HookResource, PermissionPolicyResource, ProjectContext } from '../types.js';
import type { TargetId } from '../constants.js';
import { recordAudit } from '../core/audit.js';
import { effectivePolicyEffect, matchPathGlob, matchWildcard } from '../core/governance.js';
import { parseMcpTool, resolveToolCapability, unknownToolDecision, unknownToolGap, type Capability } from '../core/tool-capability.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadSelectedResources, type SelectedResources } from '../core/resource-loader.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { sha256 } from '../core/hash.js';
import { runProjectScript } from '../runners/script.js';

type Decision = 'allow' | 'ask' | 'deny' | null;

const DECISION_RANK: Record<Exclude<Decision, null>, number> = { deny: 3, ask: 2, allow: 1 };

function combineDecisions(decisions: Decision[]): Decision {
  return decisions.reduce<Decision>((strongest, candidate) => {
    if (!candidate) return strongest;
    if (!strongest || DECISION_RANK[candidate] > DECISION_RANK[strongest]) return candidate;
    return strongest;
  }, null);
}

/** A failed/timed-out/malformed script-backed Hook still owes the caller a decision when the
 * event is blocking; failurePolicy says what that decision should be. `spool`/`warn` never
 * block — the distinction is only in how the failure is reported via audit `outcome`. */
function failurePolicyDecision(failurePolicy: HookResource['spec']['failurePolicy']): Decision {
  if (failurePolicy === 'deny' || failurePolicy === 'stop') return 'deny';
  if (failurePolicy === 'ask') return 'ask';
  return null;
}

interface ScriptHookOutcome {
  hookId: string;
  scriptId: string;
  decision: Decision;
  reason: string | null;
  failed: boolean;
  spooled: boolean;
}

function parseScriptDecision(stdout: string): { decision: Decision; reason: string | null } | null {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && (parsed.decision === undefined || ['allow', 'ask', 'deny', null].includes(parsed.decision))) {
        return { decision: parsed.decision ?? null, reason: typeof parsed.reason === 'string' ? parsed.reason : null };
      }
    } catch { /* not a decision line; keep scanning */ }
  }
  return null;
}

async function runScriptHooks(project: ProjectContext, resources: SelectedResources, event: string, payload: Record<string, unknown>): Promise<ScriptHookOutcome[]> {
  const matching = [...resources.hooks.entries()].filter(([, item]) => item.value.spec.enabled && item.value.spec.event === event && item.value.spec.action?.scriptRef);
  const outcomes: ScriptHookOutcome[] = [];
  for (const [hookId, item] of matching) {
    const scriptId = item.value.spec.action!.scriptRef!;
    const failurePolicy = item.value.spec.failurePolicy;
    try {
      const result = await runProjectScript(project, scriptId, [], { stdin: JSON.stringify(payload) });
      if (result.timedOut || result.exitCode !== 0) {
        outcomes.push({ hookId, scriptId, decision: failurePolicyDecision(failurePolicy), reason: `Script ${scriptId} exited ${result.exitCode} (timedOut=${result.timedOut}).`, failed: true, spooled: failurePolicy === 'spool' });
        continue;
      }
      const parsed = parseScriptDecision(result.stdout);
      if (!parsed) {
        outcomes.push({ hookId, scriptId, decision: null, reason: null, failed: false, spooled: false });
        continue;
      }
      outcomes.push({ hookId, scriptId, decision: parsed.decision, reason: parsed.reason, failed: false, spooled: false });
    } catch (error) {
      outcomes.push({ hookId, scriptId, decision: failurePolicyDecision(failurePolicy), reason: (error as Error).message, failed: true, spooled: failurePolicy === 'spool' });
    }
  }
  return outcomes;
}

/** Path capabilities use real glob semantics (`*` never crosses `/`); everything else stays loose. */
function matchesPattern(capabilityName: Capability, pattern: string, value: string): boolean {
  if (capabilityName === 'fs.read' || capabilityName === 'fs.write') return matchPathGlob(pattern, value);
  return matchWildcard(pattern, value);
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function tool(payload: Record<string, any>): string {
  return String(payload.tool_name ?? payload.toolName ?? payload.tool ?? payload.name ?? 'unknown');
}

function toolInput(payload: Record<string, any>): Record<string, any> {
  const input = payload.tool_input ?? payload.toolArgs ?? payload.input ?? payload.args ?? {};
  return input && typeof input === 'object' ? input : { value: input };
}

function patchPaths(command: string): string[] {
  return [...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((match) => match[1]!.trim());
}

function resourcesFor(capabilityName: Capability, input: Record<string, any>, toolName: string, root: string): string[] {
  if (capabilityName === 'shell') return strings(input.command ?? input.cmd ?? input.value);
  if (capabilityName === 'fs.read' || capabilityName === 'fs.write') {
    const paths = strings(input.file_path ?? input.filePath ?? input.path ?? input.paths);
    if (paths.length === 0 && typeof input.command === 'string') paths.push(...patchPaths(input.command));
    return paths.map((item) => item.replaceAll('\\', '/').startsWith(`${root.replaceAll('\\', '/')}/`) ? item.replaceAll('\\', '/').slice(root.length + 1) : item.replace(/^\.\//, ''));
  }
  if (capabilityName === 'network') return strings(input.url ?? input.host ?? input.domain);
  if (capabilityName === 'subagent') return strings(input.agent ?? input.agent_id ?? input.subagent ?? toolName);
  if (capabilityName === 'mcp') {
    // `match.mcpServers` holds bare server ids while the payload carries the namespaced tool name,
    // so expose both: `filesystem` and `mcp__filesystem__read_file` must each be matchable.
    const ref = parseMcpTool(toolName);
    return ref ? [...new Set([toolName, ref.server, ...(ref.tool ? [`${ref.server}__${ref.tool}`] : [])])] : [toolName];
  }
  return [toolName];
}

function policyPatterns(policy: PermissionPolicyResource): string[] {
  const match = policy.spec.match;
  if (policy.spec.capability === 'shell') return match.commands ?? [];
  if (policy.spec.capability === 'fs.read' || policy.spec.capability === 'fs.write') return match.paths ?? [];
  if (policy.spec.capability === 'network') return match.hosts ?? [];
  if (policy.spec.capability === 'subagent') return match.tools ?? [];
  if (policy.spec.capability === 'mcp') return match.mcpServers ?? match.tools ?? [];
  return match.tools ?? [];
}

/**
 * Codex has no `ask`, so an `ask` must be resolved before it reaches the platform. Which way it
 * resolves depends on where the `ask` came from, and conflating the two sources is a real bug:
 *
 * - a PermissionPolicy that says `ask` is a human decision someone deliberately wrote down, so on a
 *   target that cannot ask, the conservative reading is `deny`;
 * - the `unknownToolPolicy` default is not an opinion about the call at all, it only says XForge
 *   could not classify the tool. Denying that would block `Grep`/`Glob`/`Search` on every Codex
 *   call as soon as any policy exists, which is most projects. The gap is still recorded in the
 *   audit chain, and a genuinely dangerous unrecognised tool is still caught through the capability
 *   hint, so degrading to "no opinion" loses no enforcement.
 */
function resolveUnaskable(decision: Decision, askIsUnknownToolOnly: boolean): Decision {
  if (decision !== 'ask') return decision;
  return askIsUnknownToolOnly ? null : 'deny';
}

function platformOutput(target: TargetId, event: string, decision: Decision, reason: string, askIsUnknownToolOnly = false): Record<string, unknown> {
  if (!decision || !event.includes('before') && !event.includes('permission')) return {};
  if (target === 'cursor') return { permission: decision, user_message: reason, agent_message: reason };
  if (target === 'github-copilot') return { permissionDecision: decision, permissionDecisionReason: reason };
  if (target === 'opencode') return { decision, reason };
  const hookEventName = event === 'agent.permission.request' ? 'PermissionRequest' : 'PreToolUse';
  if (hookEventName === 'PermissionRequest') {
    if (decision === 'ask') return {};
    return { hookSpecificOutput: { hookEventName, decision: { behavior: decision, ...(decision === 'deny' ? { message: reason } : {}) } } };
  }
  const effective = target === 'codex' ? resolveUnaskable(decision, askIsUnknownToolOnly) : decision;
  if (!effective) return {};
  return { hookSpecificOutput: { hookEventName, permissionDecision: effective, permissionDecisionReason: reason } };
}

export function hookFailureOutput(target: TargetId, event: string): Record<string, unknown> {
  if (!event.includes('before') && !event.includes('permission')) return {};
  return platformOutput(target, event, 'deny', 'XForge governance dispatcher failed closed.');
}

export async function executeHookDispatch(project: ProjectContext, options: { target: TargetId; event: string; payload: Record<string, any> }): Promise<{
  platformOutput: Record<string, unknown>;
  decision: Decision;
  policyRefs: string[];
  scriptHooks: Array<{ hookId: string; scriptId: string; decision: Decision; failed: boolean }>;
}> {
  const selected = await loadSelectedResources(project);
  const payloadTool = tool(options.payload);
  const input = toolInput(options.payload);
  const resolution = resolveToolCapability(options.target, payloadTool);
  const capabilityName = resolution.capability;
  /** Capability actually used to select and match policies. For an unrecognised tool this is the
   * heuristic hint, which only ever adds coverage — the `unknown` verdict below still stands. */
  const matchCapability: Capability | null = capabilityName === 'none' ? null : capabilityName === 'unknown' ? resolution.hint : capabilityName;
  const actor = String(options.payload.actor ?? options.payload.agent ?? options.payload.agent_id ?? 'agent');
  let change = String(options.payload.change ?? process.env.XFORGE_CHANGE ?? '') || null;
  let flow: string | null = null;
  let stage: string | null = null;
  let revision: any = undefined;
  if (change) {
    try {
      const resolved = await resolveChangeState(project, change);
      flow = resolved.flow.metadata.name;
      if (isStageFlow(resolved.flow) && resolved.flow.governance) {
        const control = await resolveControlPlane(project, change, resolved.flow, resolved.state, selected, resolved.config);
        stage = control.governance.currentStage;
        revision = control.governance.revision;
      }
    } catch { change = null; }
  }
  const values = matchCapability ? resourcesFor(matchCapability, input, payloadTool, project.root) : capabilityName === 'unknown' ? [payloadTool] : [];
  const applicable = matchCapability ? [...selected.policies.values()].map((item) => item.value).filter((policy) => {
    if (policy.spec.capability !== matchCapability || policy.spec.exceptActors?.includes(actor)) return false;
    if (policy.spec.match.stages?.length && stage && !policy.spec.match.stages.includes(stage)) return false;
    const patterns = policyPatterns(policy);
    if (patterns.length === 0) return true;
    return values.some((value) => patterns.some((pattern) => matchesPattern(matchCapability, pattern, value)));
  }) : [];
  const policyDecision = effectivePolicyEffect(applicable);
  const policyReason = applicable.map((policy) => policy.spec.reason).join(' ') || 'No XForge PermissionPolicy matched.';
  const policyRefs = applicable.map((policy) => policy.metadata.name);

  /** An unclassifiable tool must never be silently allowed: it is a hole in the policy surface.
   * On a target with no `ask`, see `resolveUnaskable` for why this specific ask is not a deny. */
  const unknownDecision = capabilityName === 'unknown' ? unknownToolDecision(project.manifest) : null;
  const unknownReason = unknownDecision ? `Tool "${payloadTool}" is not mapped to an XForge capability for target ${options.target}; applying unknownToolPolicy=${unknownDecision}.` : null;

  const scriptOutcomes = await runScriptHooks(project, selected, options.event, options.payload);
  const decision = combineDecisions([policyDecision, unknownDecision, ...scriptOutcomes.map((item) => item.decision)]);
  const reasonParts = [applicable.length ? policyReason : null, unknownReason, ...scriptOutcomes.filter((item) => item.reason).map((item) => `[${item.hookId}] ${item.reason}`)].filter((part): part is string => Boolean(part));
  const reason = reasonParts.join(' ') || 'No XForge PermissionPolicy or script Hook matched.';
  const anySpooled = scriptOutcomes.some((item) => item.spooled);
  const anyFailedBlocking = scriptOutcomes.some((item) => item.failed && !item.spooled);

  const coverageGaps: string[] = [];
  if (capabilityName === 'unknown') coverageGaps.push(unknownToolGap(payloadTool));
  if (matchCapability && values.length === 0) coverageGaps.push(`resource-unavailable:${matchCapability}`);

  await recordAudit(project, {
    eventType: options.event, plane: 'runtime', platform: options.target, surface: options.payload.surface === 'cloud' ? 'cloud' : 'local',
    sessionId: String(options.payload.session_id ?? options.payload.sessionId ?? 'unknown'), turnId: String(options.payload.turn_id ?? options.payload.turnId ?? options.payload.prompt_id ?? 'unknown'),
    toolCallId: String(options.payload.tool_use_id ?? options.payload.toolCallId ?? 'unknown'), correlationId: options.payload.correlation_id ?? options.payload.correlationId,
    actor: { id: actor, provider: options.target, role: String(options.payload.agent_type ?? 'agent'), type: 'agent' }, change, flow, stage, revision,
    refs: { policies: policyRefs }, decision, reason: reasonParts.length ? reason : null,
    outcome: decision === 'deny' ? 'denied' : anySpooled ? 'spooled' : anyFailedBlocking ? 'failed' : 'succeeded',
    input: { tool: payloadTool, capability: capabilityName, capabilitySource: resolution.source, capabilityHint: resolution.hint, resourceDigests: values.map((value) => sha256(value)), scriptHooks: scriptOutcomes.map((item) => item.hookId) },
    output: { decision }, coverage: { observed: true, gaps: coverageGaps },
  });
  /* True only when nothing but the unknown-tool default asked. A policy or script Hook that also
     asked keeps the conservative deny on targets without `ask`. */
  const askIsUnknownToolOnly = decision === 'ask'
    && unknownDecision === 'ask'
    && policyDecision !== 'ask'
    && !scriptOutcomes.some((item) => item.decision === 'ask');
  return {
    platformOutput: platformOutput(options.target, options.event, decision, reason, askIsUnknownToolOnly),
    decision, policyRefs,
    scriptHooks: scriptOutcomes.map((item) => ({ hookId: item.hookId, scriptId: item.scriptId, decision: item.decision, failed: item.failed })),
  };
}
