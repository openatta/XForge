import { createRequire } from 'node:module';
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
const NOCASE = process.platform === 'win32';
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
 */
export function matchWildcard(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, NOCASE ? 'i' : '').test(value);
}

export function effectivePolicyEffect(policies: PermissionPolicyResource[]): 'deny' | 'ask' | 'allow' | null {
  if (policies.some((policy) => policy.spec.effect === 'deny')) return 'deny';
  if (policies.some((policy) => policy.spec.effect === 'ask')) return 'ask';
  if (policies.some((policy) => policy.spec.effect === 'allow')) return 'allow';
  return null;
}
