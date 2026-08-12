import type { TargetId } from '../constants.js';
import type { Manifest, PermissionPolicyResource } from '../types.js';

/**
 * Tool name -> PermissionPolicy capability resolution for the runtime bridge.
 *
 * Why this file exists: the bridge used to guess a tool's capability with an ordered regex
 * cascade over the tool name. That was order sensitive (`mcp__filesystem__read_file` matched
 * `/read/` before the MCP branch ever ran) and leaky (`Grep`, `Glob`, `Search` matched nothing,
 * produced a `null` capability, and were therefore silently allowed without even a coverage gap).
 *
 * The replacement is an explicit, per-target table. Three outcomes are possible:
 *
 * - a `Capability`  the tool is known and is governed by that capability
 * - `'none'`        the tool is known and is deliberately outside the capability model
 *                   (plan/todo bookkeeping and similar); no policy, no decision, no gap
 * - `'unknown'`     the tool is not recognised. The dispatcher must NOT silently allow: it
 *                   applies `manifest.runtime.unknownToolPolicy` (default `ask`) and records an
 *                   `unknown-tool:<name>` coverage gap so the hole is visible in the audit chain.
 *
 * A name heuristic is still kept, but only as a *hint*: it can add defence in depth (an
 * unrecognised write-shaped tool is still evaluated against `fs.write` policies) while the
 * resolution itself stays `'unknown'`, so the ask + coverage gap still happens. The heuristic can
 * never upgrade an unrecognised tool into a confident answer.
 */

export type Capability = PermissionPolicyResource['spec']['capability'];
export type ResolvedCapability = Capability | 'none' | 'unknown';

export interface ToolCapabilityResolution {
  /** Authoritative classification used for auditing and for the unknown-tool decision. */
  capability: ResolvedCapability;
  /** Low-confidence heuristic guess, only ever set when `capability === 'unknown'`. */
  hint: Capability | null;
  /** Where the answer came from, for diagnostics. */
  source: 'mcp' | 'table' | 'heuristic' | 'unrecognised';
}

/** Parsed form of a namespaced MCP tool call, e.g. `mcp__filesystem__read_file`. */
export interface McpToolRef {
  server: string;
  tool: string | null;
}

/**
 * Recognise MCP tool names before any other rule.
 *
 * Accepted shapes (case insensitive):
 * - `mcp__<server>__<tool>`  Claude Code / Codex / Copilot canonical form
 * - `mcp:<server>.<tool>` / `mcp:<server>/<tool>`  Cursor's `MCP:` prefixed form
 * - `mcp.<server>.<tool>`
 * - bare `mcp`
 */
export function parseMcpTool(toolName: string): McpToolRef | null {
  const name = toolName.trim();
  const lower = name.toLowerCase();
  if (lower === 'mcp') return { server: '*', tool: null };
  if (lower.startsWith('mcp__')) {
    const [server, ...rest] = name.slice(5).split('__');
    if (!server) return null;
    return { server, tool: rest.length > 0 ? rest.join('__') : null };
  }
  if (lower.startsWith('mcp:') || lower.startsWith('mcp.') || lower.startsWith('mcp/')) {
    const [server, ...rest] = name.slice(4).split(/[./]/);
    if (!server) return null;
    return { server, tool: rest.length > 0 ? rest.join('.') : null };
  }
  return null;
}

export function isMcpTool(toolName: string): boolean {
  return parseMcpTool(toolName) !== null;
}

/**
 * Names shared across coding agents. Keys are lower-cased tool names.
 *
 * `'unknown'` entries are deliberate: those tools are recognised, but their resource is a *query*
 * (a regex, a glob, a semantic phrase) rather than a concrete path, so mapping them onto
 * `fs.read` and then matching `match.paths` against a pattern string would produce a confidently
 * wrong verdict. They are routed through the unknown path so an operator has to choose.
 */
const SHARED_TOOLS: Record<string, ResolvedCapability> = {
  // shell
  bash: 'shell',
  sh: 'shell',
  shell: 'shell',
  terminal: 'shell',
  exec: 'shell',
  exec_command: 'shell',
  execcommand: 'shell',
  execute: 'shell',
  local_shell: 'shell',
  'container.exec': 'shell',
  run_command: 'shell',
  run_in_terminal: 'shell',
  runcommand: 'shell',
  write_stdin: 'shell',
  // filesystem reads
  read: 'fs.read',
  read_file: 'fs.read',
  readfile: 'fs.read',
  view: 'fs.read',
  view_image: 'fs.read',
  cat: 'fs.read',
  notebookread: 'fs.read',
  // filesystem writes
  write: 'fs.write',
  write_file: 'fs.write',
  writefile: 'fs.write',
  create: 'fs.write',
  create_file: 'fs.write',
  edit: 'fs.write',
  edit_file: 'fs.write',
  multiedit: 'fs.write',
  notebookedit: 'fs.write',
  patch: 'fs.write',
  apply_patch: 'fs.write',
  applypatch: 'fs.write',
  str_replace: 'fs.write',
  str_replace_editor: 'fs.write',
  replace_string_in_file: 'fs.write',
  insert_edit_into_file: 'fs.write',
  delete: 'fs.write',
  remove: 'fs.write',
  rename: 'fs.write',
  move: 'fs.write',
  // network
  webfetch: 'network',
  web_fetch: 'network',
  fetch: 'network',
  fetch_webpage: 'network',
  websearch: 'network',
  web_search: 'network',
  browser: 'network',
  // subagents
  task: 'subagent',
  agent: 'subagent',
  subagent: 'subagent',
  spawn_agent: 'subagent',
  dispatch_agent: 'subagent',
  // recognised but outside the capability model
  todowrite: 'none',
  todoread: 'none',
  todo: 'none',
  update_plan: 'none',
  exitplanmode: 'none',
  // invoking a slash command is not itself a governable resource (unlike whatever tool calls the
  // command body eventually makes, which are each classified on their own merits), so it belongs
  // with the other bookkeeping tools above rather than routed through the unknown-tool/ask path.
  slashcommand: 'none',
  // recognised but deliberately ambiguous -> unknown path
  grep: 'unknown',
  glob: 'unknown',
  search: 'unknown',
  ls: 'unknown',
  list: 'unknown',
  list_dir: 'unknown',
  file_search: 'unknown',
  grep_search: 'unknown',
  semantic_search: 'unknown',
  codebase_search: 'unknown',
};

/** Target-specific names and overrides. Consulted before {@link SHARED_TOOLS}. */
const TARGET_TOOLS: Record<TargetId, Record<string, ResolvedCapability>> = {
  claude: {
    bash: 'shell',
    bashoutput: 'none',
    killshell: 'none',
    killbash: 'none',
    read: 'fs.read',
    write: 'fs.write',
    edit: 'fs.write',
    notebookedit: 'fs.write',
    webfetch: 'network',
    websearch: 'network',
    task: 'subagent',
    listmcpresources: 'mcp',
    readmcpresource: 'mcp',
  },
  codex: {
    shell: 'shell',
    local_shell: 'shell',
    exec_command: 'shell',
    write_stdin: 'shell',
    apply_patch: 'fs.write',
    read_file: 'fs.read',
    view_image: 'fs.read',
    update_plan: 'none',
    web_search: 'network',
  },
  cursor: {
    shell: 'shell',
    read: 'fs.read',
    write: 'fs.write',
    edit: 'fs.write',
    delete: 'fs.write',
    task: 'subagent',
    mcp: 'mcp',
    fetch: 'network',
  },
  opencode: {
    bash: 'shell',
    read: 'fs.read',
    write: 'fs.write',
    edit: 'fs.write',
    patch: 'fs.write',
    webfetch: 'network',
    task: 'subagent',
    todowrite: 'none',
    todoread: 'none',
    invalid: 'none',
  },
  'github-copilot': {
    bash: 'shell',
    run_in_terminal: 'shell',
    view: 'fs.read',
    read_file: 'fs.read',
    create: 'fs.write',
    create_file: 'fs.write',
    str_replace_editor: 'fs.write',
    replace_string_in_file: 'fs.write',
    insert_edit_into_file: 'fs.write',
    fetch_webpage: 'network',
    run_task: 'shell',
  },
};

/**
 * The real (target-specific) tool names {@link TARGET_TOOLS} knows about for a target, in table
 * order. Exported so consumers that need to build something *from* the tool names themselves
 * (rather than resolve a capability for one) — e.g. the Cursor `PreToolUse` hook matcher in
 * `adapters/governance.ts` — read them from this single source of truth instead of maintaining a
 * second, hand-written list that can silently drift from the one used for capability resolution.
 */
export function targetToolNames(target: TargetId): string[] {
  return Object.keys(TARGET_TOOLS[target] ?? {});
}

/**
 * Last-resort name heuristic. Never authoritative: its answer is returned as
 * {@link ToolCapabilityResolution.hint} while the resolution stays `'unknown'`.
 *
 * Ordering here still matters, but it can no longer cause a silent wrong answer, and MCP has
 * already been resolved before this runs.
 */
function heuristicHint(lowerName: string): Capability | null {
  if (/(^|[^a-z])(bash|shell|terminal|exec|command)([^a-z]|$)/.test(lowerName)) return 'shell';
  if (/write|edit|patch|delete|create|remove|replace/.test(lowerName)) return 'fs.write';
  if (/read|view|open|cat/.test(lowerName)) return 'fs.read';
  if (/agent|subagent|spawn/.test(lowerName)) return 'subagent';
  if (/web|fetch|http|browser|url/.test(lowerName)) return 'network';
  return null;
}

/** Resolve a tool name for a target. MCP is always decided before any substring heuristic. */
export function resolveToolCapability(target: TargetId, toolName: string): ToolCapabilityResolution {
  const name = String(toolName ?? '').trim();
  if (isMcpTool(name)) return { capability: 'mcp', hint: null, source: 'mcp' };

  const lower = name.toLowerCase();
  const fromTarget = TARGET_TOOLS[target]?.[lower];
  const resolved = fromTarget ?? SHARED_TOOLS[lower];
  if (resolved && resolved !== 'unknown') return { capability: resolved, hint: null, source: 'table' };
  if (resolved === 'unknown') return { capability: 'unknown', hint: null, source: 'table' };

  const hint = heuristicHint(lower);
  return { capability: 'unknown', hint, source: hint ? 'heuristic' : 'unrecognised' };
}

export type UnknownToolPolicy = 'allow' | 'ask' | 'deny';

export const DEFAULT_UNKNOWN_TOOL_POLICY: UnknownToolPolicy = 'ask';

export function unknownToolPolicy(manifest: Manifest): UnknownToolPolicy {
  const configured = manifest.runtime?.unknownToolPolicy;
  return configured === 'allow' || configured === 'ask' || configured === 'deny' ? configured : DEFAULT_UNKNOWN_TOOL_POLICY;
}

/**
 * Decision contributed by the unknown-tool policy.
 *
 * `allow` yields `null` on purpose: it means "XForge has no opinion, the platform's own permission
 * model applies", which is exactly how a *known* capability with no matching policy behaves. If
 * `allow` emitted a positive `allow` decision, an unrecognised tool would end up strictly more
 * privileged than a recognised one.
 */
export function unknownToolDecision(manifest: Manifest): 'ask' | 'deny' | null {
  const policy = unknownToolPolicy(manifest);
  return policy === 'allow' ? null : policy;
}

/** Coverage-gap marker recorded whenever a tool could not be classified. */
export function unknownToolGap(toolName: string): string {
  return `unknown-tool:${toolName}`;
}
