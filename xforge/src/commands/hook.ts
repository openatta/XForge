import type { PermissionPolicyResource, ProjectContext } from '../types.js';
import type { TargetId } from '../constants.js';
import { recordAudit } from '../core/audit.js';
import { effectivePolicyEffect } from '../core/governance.js';
import { isStageFlow, resolveChangeState } from '../core/flow-resolver.js';
import { loadSelectedResources } from '../core/resource-loader.js';
import { resolveControlPlane } from '../core/control-plane.js';
import { sha256 } from '../core/hash.js';

type Decision = 'allow' | 'ask' | 'deny' | null;

function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '').test(value);
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

function capability(toolName: string, input: Record<string, any>): PermissionPolicyResource['spec']['capability'] | null {
  const name = toolName.toLowerCase();
  if (/bash|shell|terminal|exec_command/.test(name)) return 'shell';
  if (/write|edit|patch|delete/.test(name)) return 'fs.write';
  if (/read|view/.test(name)) return 'fs.read';
  if (/agent|task|subagent|spawn/.test(name)) return 'subagent';
  if (/web|fetch|browser/.test(name) || typeof input.url === 'string') return 'network';
  if (/^mcp|mcp__|mcp:/.test(name)) return 'mcp';
  return null;
}

function patchPaths(command: string): string[] {
  return [...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((match) => match[1]!.trim());
}

function resourcesFor(capabilityName: PermissionPolicyResource['spec']['capability'], input: Record<string, any>, toolName: string, root: string): string[] {
  if (capabilityName === 'shell') return strings(input.command ?? input.cmd ?? input.value);
  if (capabilityName === 'fs.read' || capabilityName === 'fs.write') {
    const paths = strings(input.file_path ?? input.filePath ?? input.path ?? input.paths);
    if (paths.length === 0 && typeof input.command === 'string') paths.push(...patchPaths(input.command));
    return paths.map((item) => item.replaceAll('\\', '/').startsWith(`${root.replaceAll('\\', '/')}/`) ? item.replaceAll('\\', '/').slice(root.length + 1) : item.replace(/^\.\//, ''));
  }
  if (capabilityName === 'network') return strings(input.url ?? input.host ?? input.domain);
  if (capabilityName === 'subagent') return strings(input.agent ?? input.agent_id ?? input.subagent ?? toolName);
  if (capabilityName === 'mcp') return [toolName];
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

function platformOutput(target: TargetId, event: string, decision: Decision, reason: string): Record<string, unknown> {
  if (!decision || !event.includes('before') && !event.includes('permission')) return {};
  if (target === 'cursor') return { permission: decision, user_message: reason, agent_message: reason };
  if (target === 'github-copilot') return { permissionDecision: decision, permissionDecisionReason: reason };
  if (target === 'opencode') return { decision, reason };
  const hookEventName = event === 'agent.permission.request' ? 'PermissionRequest' : 'PreToolUse';
  if (hookEventName === 'PermissionRequest') {
    if (decision === 'ask') return {};
    return { hookSpecificOutput: { hookEventName, decision: { behavior: decision, ...(decision === 'deny' ? { message: reason } : {}) } } };
  }
  const effective = target === 'codex' && decision === 'ask' ? 'deny' : decision;
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
}> {
  const selected = await loadSelectedResources(project);
  const payloadTool = tool(options.payload);
  const input = toolInput(options.payload);
  const capabilityName = capability(payloadTool, input);
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
  const values = capabilityName ? resourcesFor(capabilityName, input, payloadTool, project.root) : [];
  const applicable = capabilityName ? [...selected.policies.values()].map((item) => item.value).filter((policy) => {
    if (policy.spec.capability !== capabilityName || policy.spec.exceptActors?.includes(actor)) return false;
    if (policy.spec.match.stages?.length && stage && !policy.spec.match.stages.includes(stage)) return false;
    const patterns = policyPatterns(policy);
    if (patterns.length === 0) return true;
    return values.some((value) => patterns.some((pattern) => wildcard(pattern, value)));
  }) : [];
  const decision = effectivePolicyEffect(applicable);
  const reason = applicable.map((policy) => policy.spec.reason).join(' ') || 'No XForge PermissionPolicy matched.';
  const policyRefs = applicable.map((policy) => policy.metadata.name);
  await recordAudit(project, {
    eventType: options.event, plane: 'runtime', platform: options.target, surface: options.payload.surface === 'cloud' ? 'cloud' : 'local',
    sessionId: String(options.payload.session_id ?? options.payload.sessionId ?? 'unknown'), turnId: String(options.payload.turn_id ?? options.payload.turnId ?? options.payload.prompt_id ?? 'unknown'),
    toolCallId: String(options.payload.tool_use_id ?? options.payload.toolCallId ?? 'unknown'), correlationId: options.payload.correlation_id ?? options.payload.correlationId,
    actor: { id: actor, provider: options.target, role: String(options.payload.agent_type ?? 'agent'), type: 'agent' }, change, flow, stage, revision,
    refs: { policies: policyRefs }, decision, reason: applicable.length ? reason : null, outcome: decision === 'deny' ? 'denied' : 'succeeded',
    input: { tool: payloadTool, capability: capabilityName, resourceDigests: values.map((value) => sha256(value)) },
    output: { decision }, coverage: { observed: true, gaps: values.length === 0 && capabilityName ? [`resource-unavailable:${capabilityName}`] : [] },
  });
  return { platformOutput: platformOutput(options.target, options.event, decision, reason), decision, policyRefs };
}
