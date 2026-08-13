import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangeConfig, PermissionPolicyResource, RuleResource } from '../types.js';

export interface NormalizedRule {
  id: string;
  severity: 'must' | 'should';
  instruction: string;
  modules: string[];
  paths: string[];
  stages: string[];
  gateRefs: string[];
  policyRefs: string[];
  approvalRefs: string[];
  constitutionCompatibility: 'compatible' | 'conflict';
  legacyWritePolicy: 'integrator-only' | null;
}

export function normalizeRule(rule: RuleResource): NormalizedRule {
  const legacy = rule.apiVersion === 'xforge.dev/v1alpha1';
  return {
    id: rule.metadata.name,
    severity: rule.spec.severity ?? (rule.spec.level === 'advisory' ? 'should' : 'must'),
    instruction: rule.spec.instruction,
    modules: rule.spec.scope?.modules ?? rule.spec.modules ?? [],
    paths: rule.spec.scope?.paths ?? rule.spec.paths ?? [],
    stages: rule.spec.scope?.stages ?? [],
    gateRefs: rule.spec.enforcement?.gateRefs ?? (rule.spec.gate ? [rule.spec.gate] : []),
    policyRefs: rule.spec.enforcement?.policyRefs ?? [],
    approvalRefs: rule.spec.enforcement?.approvalRefs ?? [],
    constitutionCompatibility: rule.spec.constitutionCompatibility ?? 'compatible',
    legacyWritePolicy: legacy && rule.spec.writePolicy === 'integrator-only' ? 'integrator-only' : null,
  };
}

export function ruleApplies(rule: NormalizedRule, config: ChangeConfig, stage?: string): boolean {
  if (rule.modules.length > 0 && !rule.modules.some((module) => config.scope.modules.includes(module))) return false;
  if (rule.stages.length > 0 && stage && !rule.stages.includes(stage)) return false;
  if (rule.paths.length > 0 && !rule.paths.some((rulePath) => config.scope.paths.some((scopePath) => {
    const ruleRoot = rulePath.replace(/\/\*\*.*$/, '');
    const scopeRoot = scopePath.replace(/\/\*\*.*$/, '');
    return ruleRoot === scopeRoot || ruleRoot.startsWith(`${scopeRoot}/`) || scopeRoot.startsWith(`${ruleRoot}/`);
  }))) return false;
  return true;
}

export function policyApplies(policy: PermissionPolicyResource, config: ChangeConfig, stage?: string): boolean {
  const stages = policy.spec.match.stages ?? [];
  if (stages.length > 0 && stage && !stages.includes(stage)) return false;
  const paths = policy.spec.match.paths ?? [];
  if (paths.length === 0) return true;
  return paths.some((policyPath) => config.scope.paths.some((scopePath) => {
    const policyRoot = policyPath.replace(/\/\*\*.*$/, '');
    const scopeRoot = scopePath.replace(/\/\*\*.*$/, '');
    return policyRoot === scopeRoot || policyRoot.startsWith(`${scopeRoot}/`) || scopeRoot.startsWith(`${policyRoot}/`);
  }));
}

/**
 * Path-glob semantics shared by the static projections and the runtime bridge.
 *
 * The bridge used to compile `*` to `.*`, which crosses `/`, so `src/**` also matched
 * `srcfoo/x` while every platform's own glob said otherwise. The two layers could therefore
 * disagree on the same policy, and the audit chain recorded the bridge's answer.
 *
 * The semantics fixed here, and expected everywhere:
 * - `*`  matches zero or more characters **within one path segment** (never crosses `/`)
 * - `**` matches zero or more whole segments (crosses `/`); `src/**` also matches `src` itself
 * - `?`  matches exactly one character that is not `/`
 * - `[...]` is a character class; `[!...]` / `[^...]` negate it
 * - dotfiles are matched like any other name
 *
 * `picomatch` is the reference implementation. It ships inside `fast-glob`, which is already a
 * direct dependency, so no new package is introduced. {@link matchPathGlobFallback} is a
 * self-contained degraded path used only if that resolution ever fails (for example under a
 * strict, non-hoisting installer); it covers the subset above but not braces, extglobs or
 * leading-`!` negation.
 */
type PathMatcher = (value: string) => boolean;

const requireFromHere = createRequire(import.meta.url);

/**
 * Case sensitivity of *path* matching must follow the filesystem, not the OS family.
 *
 * This used to be `process.platform === 'win32'`, which made the matcher case-sensitive on macOS —
 * where the default APFS volume is case-*insensitive*. `xforge/manifest.yaml` and
 * `XForge/Manifest.yaml` are the same file to every editor tool there, but only the first one
 * matched `protected-files`, so a single capitalisation defeated the policy.
 *
 * Windows and macOS are treated as case-insensitive unconditionally (their defaults, and erring
 * that way means a `deny` policy covers *more* spellings of the same file, which is the safe
 * direction). Elsewhere the answer is probed once at load by asking the filesystem whether this
 * module's own file is reachable under a case-flipped name — that catches a case-insensitive mount
 * on Linux. The probe inspects the CLI's own location rather than a project root because the
 * matcher is context-free; a project on a differently-cased volume than the CLI is the known
 * residual gap, and it resolves toward `false` (stricter matching), never toward silently matching
 * nothing.
 */
function caseInsensitiveFilesystem(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  try {
    const self = fileURLToPath(import.meta.url);
    const base = path.basename(self);
    const flipped = base === base.toLowerCase() ? base.toUpperCase() : base.toLowerCase();
    if (flipped === base) return false;
    return statSync(path.join(path.dirname(self), flipped)).isFile();
  } catch {
    return false;
  }
}

const NOCASE = caseInsensitiveFilesystem();
/** Non-path patterns (commands, hosts, tool names) are not filesystem entries, so they keep the
 *  previous OS-family rule rather than inheriting the volume's case folding. */
const WILDCARD_NOCASE = process.platform === 'win32';
const matcherCache = new Map<string, PathMatcher>();
let picomatchFactory: ((pattern: string, options: Record<string, unknown>) => PathMatcher) | null | undefined;

function loadPicomatch(): typeof picomatchFactory {
  if (picomatchFactory !== undefined) return picomatchFactory;
  try {
    picomatchFactory = requireFromHere('picomatch') as (pattern: string, options: Record<string, unknown>) => PathMatcher;
  } catch {
    picomatchFactory = null;
  }
  return picomatchFactory;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function escapeLiteral(value: string): string {
  return value.replace(/[.+^${}()|[\]\\?*]/g, '\\$&');
}

/** Compile one `/`-free glob segment. */
function segmentSource(segment: string): string {
  let source = '';
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === '*') { source += '[^/]*'; continue; }
    if (char === '?') { source += '[^/]'; continue; }
    if (char === '[') {
      const close = segment.indexOf(']', index + 1);
      if (close > index) {
        const body = segment.slice(index + 1, close).replace(/^[!^]/, '^');
        source += `[${body}]`;
        index = close;
        continue;
      }
    }
    source += escapeLiteral(char);
  }
  return source;
}

/** Degraded, dependency-free implementation of the semantics documented above. */
export function matchPathGlobFallback(pattern: string, value: string): boolean {
  const segments = normalizePath(pattern).split('/').filter((segment, index, all) => !(segment === '**' && all[index - 1] === '**'));
  let source = '';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      if (isLast) source += index === 0 ? '.*' : '(?:/.*)?';
      else source += index === 0 ? '(?:[^/]+/)*' : '(?:/[^/]+)*/';
      continue;
    }
    source += (index > 0 && segments[index - 1] !== '**' ? '/' : '') + segmentSource(segment);
  }
  return new RegExp(`^${source}$`, NOCASE ? 'i' : '').test(normalizePath(value));
}

function compilePathGlob(pattern: string): PathMatcher {
  const picomatch = loadPicomatch();
  if (!picomatch) return (value) => matchPathGlobFallback(pattern, value);
  const matcher = picomatch(normalizePath(pattern), { dot: true, nocase: NOCASE });
  return (value) => matcher(value);
}

/** Match a policy `match.paths` pattern against a repo-relative path. */
export function matchPathGlob(pattern: string, value: string): boolean {
  let matcher = matcherCache.get(pattern);
  if (!matcher) {
    matcher = compilePathGlob(pattern);
    matcherCache.set(pattern, matcher);
  }
  return matcher(normalizePath(value));
}

/**
 * Loose `*`/`?` matching for non-path policy patterns: shell command lines, network hosts/URLs,
 * subagent ids and tool names. Those are not `/`-segmented namespaces — a command pattern like
 * `rm -rf *` is meant to swallow `/tmp/x` — so path-segment semantics would be wrong here.
 * Path patterns must use {@link matchPathGlob}.
 *
 * Deliberately NOT a regex. This used to compile `*` to `.*` and hand the result to `RegExp`, which
 * backtracks: with *k* wildcards a non-matching subject costs O(n^k), and the subject here is the
 * *agent's own command string*. Measured on the previous implementation, a six-wildcard `rm -rf`
 * pattern against a 900-character command took 2.7 s and `'*a*a*a*b'` against 2000 `a`s never
 * finished.
 * A hung dispatcher is a fail-open on every host that does not block on hook timeout (Claude Code
 * does not), so an agent could disable enforcement by padding its own command line.
 *
 * The replacement is the standard greedy two-pointer scan with a single backtrack anchor: linear in
 * the subject per `*`, O(n·m) worst case, no recursion and no catastrophic case. `?` matches exactly
 * one character (including a newline, which the old `.` did not); pattern characters are compared
 * literally, so regex metacharacters in a policy pattern are no longer silently significant.
 */
export function matchWildcard(pattern: string, value: string): boolean {
  const glob = WILDCARD_NOCASE ? pattern.toLowerCase() : pattern;
  const subject = WILDCARD_NOCASE ? value.toLowerCase() : value;
  let globIndex = 0;
  let subjectIndex = 0;
  let starIndex = -1;
  let resumeIndex = 0;
  while (subjectIndex < subject.length) {
    const char = globIndex < glob.length ? glob[globIndex] : undefined;
    if (char === '?' || (char !== undefined && char === subject[subjectIndex])) {
      globIndex += 1;
      subjectIndex += 1;
    } else if (char === '*') {
      starIndex = globIndex;
      resumeIndex = subjectIndex;
      globIndex += 1;
    } else if (starIndex >= 0) {
      // The most recent `*` absorbs one more character; nothing before it is ever revisited.
      resumeIndex += 1;
      globIndex = starIndex + 1;
      subjectIndex = resumeIndex;
    } else {
      return false;
    }
  }
  while (globIndex < glob.length && glob[globIndex] === '*') globIndex += 1;
  return globIndex === glob.length;
}

export function effectivePolicyEffect(policies: PermissionPolicyResource[]): 'deny' | 'ask' | 'allow' | null {
  if (policies.some((policy) => policy.spec.effect === 'deny')) return 'deny';
  if (policies.some((policy) => policy.spec.effect === 'ask')) return 'ask';
  if (policies.some((policy) => policy.spec.effect === 'allow')) return 'allow';
  return null;
}
