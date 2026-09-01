export const CLI_NAME = '@xforge/cli';
export const CLI_VERSION = '0.8.0';
export const PROTOCOL_VERSION = '2';
export const TARGETS = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'github-copilot',
] as const;

export type TargetId = (typeof TARGETS)[number];

export const GENERATED_ROOTS = [
  '.agents',
  '.codex',
  '.claude',
  '.cursor',
  '.opencode',
  '.github',
] as const;

export const DEFAULT_SPECS_PATH = 'xforge/specs';
export const DEFAULT_CHANGES_PATH = 'xforge/changes';
/**
 * The contract baseline: what each module promises the others, as last archived.
 *
 * A sibling of the Specs tree rather than a directory inside it, because the two answer different
 * questions and are merged from different deltas. A Spec says what the product must do; a contract
 * says what one module may assume of another, and a Change can move either without moving the other.
 */
export const DEFAULT_CONTRACTS_PATH = 'xforge/contracts';

/**
 * The audit tree, named once.
 *
 * Three modules declared this string — `core/audit.ts`, `core/audit/locking.ts` and
 * `commands/check.ts` — after the audit module was split by layer. Every path under it is derived,
 * so three copies is three chances for a rename to move two of them: the lock directory and the log
 * would part company silently, and the only symptom would be a lock nobody contends for.
 */
export const AUDIT_DIRECTORY = 'xforge/.audit';
export const MAX_GATE_OUTPUT_BYTES = 65_536;
export const WORK_PACKAGE_VERIFY_TIMEOUT_SECONDS = 900;
