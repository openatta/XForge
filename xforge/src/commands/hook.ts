import path from 'node:path';
import type { HookResource, PermissionPolicyResource, ProjectContext } from '../types.js';
import type { TargetId } from '../constants.js';
import { recordAudit } from '../core/audit.js';
import { XForgeError, diagnostic } from '../core/errors.js';
import { effectivePolicyEffect, matchPathGlob, matchWildcard } from '../core/governance.js';
import { parseMcpTool, resolveToolCapability, unknownToolDecision, unknownToolGap, type Capability } from '../core/tool-capability.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadSelectedResources, type SelectedResources } from '../core/resource-loader.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { resolvedResourceEntries } from '../core/lockfile.js';
import { sha256, stableStringify } from '../core/hash.js';
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

/**
 * Every field across the supported hosts that carries a filesystem path for an `fs.*` capability.
 *
 * This list used to be `file_path`/`filePath`/`path`/`paths` only, which meant `NotebookEdit`
 * (`notebook_path`), rename/move (`source`/`destination`, `old_path`/`new_path`) and any tool whose
 * payload is a bare string (wrapped by {@link toolInput} as `{value: …}`) yielded no resource at all
 * — and a capability with no resource used to be silently permitted. `value` is included for that
 * bare-string case; a body-shaped value is dropped by the newline filter in
 * {@link fsPathCandidates} rather than becoming an unmatchable pseudo-path.
 */
const FS_PATH_FIELDS = [
  'file_path', 'filePath', 'path', 'paths', 'target_file', 'targetFile',
  'notebook_path', 'notebookPath',
  'old_path', 'oldPath', 'new_path', 'newPath', 'source', 'destination',
  'value',
];

function fsPathCandidates(input: Record<string, any>): string[] {
  const candidates: string[] = [];
  for (const field of FS_PATH_FIELDS) candidates.push(...strings(input[field]));
  /* Codex's `apply_patch` — its *primary* write tool — carries its paths inside the patch body, and
     the field holding that body is named `input` there, `patch` elsewhere, `command` in the shell
     form. Scanning every string-valued field instead of only `command` covers all three without
     guessing which host is calling. */
  for (const value of Object.values(input)) if (typeof value === 'string') candidates.push(...patchPaths(value));
  /* A path never contains a newline. This drops a patch body or a file's `content` that arrived in
     a path-shaped field: keeping it would add a resource string that matches nothing yet still
     counts as "a resource was extracted", suppressing the unclassified-call `ask` below. */
  return [...new Set(candidates.map((item) => item.trim()).filter((item) => item.length > 0 && !item.includes('\n')))];
}

/**
 * Repo-relative form of one payload path, or `null` when it resolves outside the project root.
 *
 * `path.resolve` + `path.relative` is the whole point: the previous implementation stripped a single
 * leading `./` and tested `startsWith(root + '/')`, so `.` segments, `//` and `..` all survived into
 * the glob matcher. `xforge/./manifest.yaml`, `xforge//manifest.yaml` and
 * `xforge/../xforge/manifest.yaml` are the same file to every host's `Write`/`Edit` tool but none of
 * them matched `protected-files`. Resolving first eliminates those forms by construction and makes
 * the inside/outside-root test authoritative for absolute paths too (`/private/tmp` vs `/tmp`, an
 * embedded `..`, a path assembled from segments).
 */
function repoRelativePath(root: string, candidate: string): string | null {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.replaceAll('\\', '/');
}

/** Resources a capability call is matched on, plus whether any of them escaped the project root. */
interface ResourceSet {
  values: string[];
  /** True when an `fs.*` path resolved outside `project.root`. Repo-relative `match.paths` globs
   *  structurally cannot classify such a path, so the caller treats it as unclassified rather than
   *  as "no policy matched". */
  escapedRoot: boolean;
}

/*
 * Known, accepted gap: a `shell` capability call is matched against `match.commands` glob
 * patterns on the raw command string only — it is never parsed for the file path(s) it might
 * write. So `cat > xforge/manifest.yaml`, `tee`, `cp`, or any script that opens a protected path
 * itself all bypass `fs.write` PermissionPolicy matching entirely; only tool calls that pass a
 * structured file-path parameter are covered. Fixing this with command-string path extraction
 * trades false negatives for false positives (a legitimate command that merely mentions a
 * protected path as an argument would wrongly deny), and a before/after filesystem-snapshot
 * approach needs cross-event state this dispatcher doesn't have. See
 * `scaffold/payload/xforge/scaffold/policies/protected-files.yaml`'s header comment for the
 * user-facing version of this same limitation.
 */
function resourcesFor(capabilityName: Capability, input: Record<string, any>, toolName: string, root: string): ResourceSet {
  if (capabilityName === 'shell') return { values: strings(input.command ?? input.cmd ?? input.value), escapedRoot: false };
  if (capabilityName === 'fs.read' || capabilityName === 'fs.write') {
    const values: string[] = [];
    let escapedRoot = false;
    for (const candidate of fsPathCandidates(input)) {
      /* A Windows-style payload reaching a POSIX runtime still has to normalise: `path.resolve`
         there would treat `xforge\manifest.yaml` as one filename. */
      const normalized = process.platform === 'win32' ? candidate : candidate.replaceAll('\\', '/');
      const relative = repoRelativePath(root, normalized);
      if (relative === null) {
        escapedRoot = true;
        // Still exposed, in its resolved absolute form, so a policy written with an absolute
        // pattern can match it; the caller separately refuses to call this a clean miss.
        values.push(path.resolve(root, normalized).replaceAll('\\', '/'));
        continue;
      }
      values.push(relative);
    }
    return { values: [...new Set(values)], escapedRoot };
  }
  if (capabilityName === 'network') return { values: strings(input.url ?? input.host ?? input.domain), escapedRoot: false };
  if (capabilityName === 'subagent') return { values: strings(input.agent ?? input.agent_id ?? input.subagent ?? toolName), escapedRoot: false };
  if (capabilityName === 'mcp') {
    // `match.mcpServers` holds bare server ids while the payload carries the namespaced tool name,
    // so expose both: `filesystem` and `mcp__filesystem__read_file` must each be matchable.
    const ref = parseMcpTool(toolName);
    return { values: ref ? [...new Set([toolName, ref.server, ...(ref.tool ? [`${ref.server}__${ref.tool}`] : [])])] : [toolName], escapedRoot: false };
  }
  return { values: [toolName], escapedRoot: false };
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

/** Resource kinds the dispatcher actually enforces with. Restricting the lock comparison to these
 *  is what keeps it off the hot path's critical cost: it digests a handful of small YAML files that
 *  `loadSelectedResources` has already read, instead of walking every Skill and Script directory the
 *  way the full `xforge install` comparison does. */
const ENFORCEMENT_KINDS = new Set(['permission-policy', 'hook']);

/**
 * Refuse to enforce with a resource set that is broken or unverified.
 *
 * Two holes this closes, both of which turned into "no opinion" (= host default = allowed):
 *
 * - `loadSelectedResources` reported a missing or schema-invalid resource as a *diagnostic* and
 *   carried on. Deleting `xforge/scaffold/policies/protected-files.yaml` (a path the policy
 *   deliberately does not deny) therefore removed the entire `fs.write` deny surface silently, and
 *   a schema-invalid policy stayed in the map with `undefined` fields, matching nothing.
 * - Nothing compared the policy files against `xforge/lock.yaml`. Replacing a policy with *valid*
 *   YAML that flips `effect: deny` to `allow` was accepted at face value. (Writing *invalid* YAML
 *   was already the safe case — `loadYaml` throws and the dispatcher fails closed.)
 *
 * Both now throw, which `cli.ts`'s hook branch turns into the fail-closed platform deny. This is the
 * same refusal `runProjectScript` already performs before executing a project Script; the dispatcher
 * had no equivalent even though it is the more security-relevant of the two.
 */
async function assertEnforceableResources(project: ProjectContext, resources: SelectedResources): Promise<void> {
  const errors = resources.diagnostics.filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    /* These are load/parse failures on the very resources that decide this call. Carry the first
       one's own message into the deny so the operator is told which file is broken, not merely
       that something is. */
    throw new XForgeError([diagnostic(
      'XFORGE_RESOURCE_UNENFORCEABLE',
      `a governance resource could not be loaded, so it refuses to decide this call: ${errors[0]!.message} Every tool call stays denied until that file is fixed or restored (\`xforge install\` rewrites the generated ones).`,
      errors[0]!.path,
    ), ...errors], { root: project.root });
  }
  const locked = (project.lock?.resources ?? []).filter((entry) => ENFORCEMENT_KINDS.has(String(entry.kind)));
  const resolved = await resolvedResourceEntries(project, {
    ...resources,
    skills: new Map(), agents: new Map(), rules: new Map(), gates: new Map(), scripts: new Map(), mcpServers: new Map(),
  });
  if (stableStringify(locked) !== stableStringify(resolved)) {
    throw new XForgeError(diagnostic(
      'XFORGE_LOCK_STALE',
      'the PermissionPolicy/Hook set on disk does not match xforge/lock.yaml, so it refuses to enforce a policy set it cannot vouch for. Every tool call stays denied until the lock is refreshed. Tell the user to run `xforge install` in the project root, then retry.',
      'xforge/lock.yaml',
    ), { root: project.root });
  }
}

/**
 * The deny a host sees when the dispatcher could not reach a decision.
 *
 * `reason` matters more than it looks. This deny is the *only* thing the host renders, and the
 * conditions that reach here are mostly configuration problems with a specific remedy — a policy
 * file edited out of step with `xforge/lock.yaml`, a resource that no longer parses. Without the
 * remedy the operator sees every tool call refused with no clue why, which reads as "XForge is
 * broken" rather than "XForge needs one command". The caller passes the diagnostic's own message
 * so the fix travels with the refusal; the generic sentence is the fallback for a failure that
 * genuinely has no better explanation (an unparsed argv, a payload that is not JSON).
 */
export function hookFailureOutput(target: TargetId, event: string, reason?: string): Record<string, unknown> {
  if (!event.includes('before') && !event.includes('permission')) return {};
  const detail = reason?.trim();
  return platformOutput(target, event, 'deny', detail
    ? `XForge governance dispatcher failed closed: ${detail}`
    : 'XForge governance dispatcher failed closed.');
}

export async function executeHookDispatch(project: ProjectContext, options: { target: TargetId; event: string; payload: Record<string, any> }): Promise<{
  platformOutput: Record<string, unknown>;
  decision: Decision;
  policyRefs: string[];
  scriptHooks: Array<{ hookId: string; scriptId: string; decision: Decision; failed: boolean }>;
}> {
  const selected = await loadSelectedResources(project);
  await assertEnforceableResources(project, selected);
  const payloadTool = tool(options.payload);
  const input = toolInput(options.payload);
  const resolution = resolveToolCapability(options.target, payloadTool);
  const capabilityName = resolution.capability;
  /** Capability actually used to select and match policies. For an unrecognised tool this is the
   * heuristic hint, which only ever adds coverage — the `unknown` verdict below still stands. */
  const matchCapability: Capability | null = capabilityName === 'none' ? null : capabilityName === 'unknown' ? resolution.hint : capabilityName;
  /*
   * Actor identity, used only by `PermissionPolicy.exceptActors`.
   *
   * `agent_type` / `subagent_type` are the fields that actually carry a sub-agent's identity on the
   * supported hosts — Claude Code sends `agent_type` (the same field this function already reads a
   * few lines down for the audit `role`), Cursor and OpenCode send `subagent_type`. `actor`,
   * `agent` and `agent_id` are kept first for XForge's own callers and tests, but no shipped host
   * sends any of them, so before this the actor was unconditionally `'agent'` and `exceptActors`
   * could never fire: `protected-files`' `exceptActors: [integrator]` applied to the Integrator too,
   * which is precisely the exemption `adapters/governance.ts` keeps this policy off the static layer
   * to preserve.
   *
   * This is a convenience exemption, not an authorization boundary: the value is supplied by the
   * host on the agent's behalf and nothing authenticates it, so a policy must not rely on
   * `exceptActors` to keep a determined caller out — that is what the deny effect itself is for.
   */
  const actor = String(options.payload.actor ?? options.payload.agent ?? options.payload.agent_id ?? options.payload.agent_type ?? options.payload.subagent_type ?? 'agent');
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
  const resourceSet: ResourceSet = matchCapability
    ? resourcesFor(matchCapability, input, payloadTool, project.root)
    : { values: capabilityName === 'unknown' ? [payloadTool] : [], escapedRoot: false };
  const values = resourceSet.values;
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

  /**
   * A capability call whose resource could not be extracted — or whose path lies outside the
   * project root, where repo-relative `match.paths` cannot reach — is an *unclassified* call, not an
   * unmatched one. It used to contribute `null`: `values` was empty, so `values.some(...)` was false
   * for every pattern-bearing policy, `applicable` came back empty, and the dispatcher returned `{}`
   * = no opinion = whatever the host would have done anyway, leaving only an after-the-fact coverage
   * gap. That was reachable with ordinary tools (Codex `apply_patch`, `NotebookEdit`, rename/move,
   * any bare-string payload), so the default is inverted here: the same `unknownToolPolicy` that
   * covers an unrecognised *tool* now covers an unreadable *resource*.
   */
  const unresolvedResource = Boolean(matchCapability) && (values.length === 0 || resourceSet.escapedRoot);
  const unresolvedDecision = unresolvedResource ? unknownToolDecision(project.manifest) : null;
  const unresolvedReason = unresolvedDecision
    ? `Tool "${payloadTool}" exercises capability ${matchCapability} but XForge could not resolve ${resourceSet.escapedRoot ? 'a project-relative path for' : 'any resource from'} its arguments; applying unknownToolPolicy=${unresolvedDecision}.`
    : null;
  /** Both of the above say "XForge could not classify this call", never "a human decided". They are
   *  therefore the two askable sources that {@link resolveUnaskable} may degrade to no-opinion. */
  const classificationDecision = combineDecisions([unknownDecision, unresolvedDecision]);

  const scriptOutcomes = await runScriptHooks(project, selected, options.event, options.payload);
  const decision = combineDecisions([policyDecision, classificationDecision, ...scriptOutcomes.map((item) => item.decision)]);
  const reasonParts = [applicable.length ? policyReason : null, unknownReason, unresolvedReason, ...scriptOutcomes.filter((item) => item.reason).map((item) => `[${item.hookId}] ${item.reason}`)].filter((part): part is string => Boolean(part));
  const reason = reasonParts.join(' ') || 'No XForge PermissionPolicy or script Hook matched.';
  const anySpooled = scriptOutcomes.some((item) => item.spooled);
  const anyFailedBlocking = scriptOutcomes.some((item) => item.failed && !item.spooled);

  const coverageGaps: string[] = [];
  if (capabilityName === 'unknown') coverageGaps.push(unknownToolGap(payloadTool));
  if (matchCapability && values.length === 0) coverageGaps.push(`resource-unavailable:${matchCapability}`);
  if (matchCapability && resourceSet.escapedRoot) coverageGaps.push(`resource-outside-root:${matchCapability}`);

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
  /* True only when nothing but an XForge could-not-classify default asked. A policy or script Hook
     that also asked keeps the conservative deny on targets without `ask`. */
  const askIsUnknownToolOnly = decision === 'ask'
    && classificationDecision === 'ask'
    && policyDecision !== 'ask'
    && !scriptOutcomes.some((item) => item.decision === 'ask');
  return {
    platformOutput: platformOutput(options.target, options.event, decision, reason, askIsUnknownToolOnly),
    decision, policyRefs,
    scriptHooks: scriptOutcomes.map((item) => ({ hookId: item.hookId, scriptId: item.scriptId, decision: item.decision, failed: item.failed })),
  };
}
