import type { NextAction, ProjectContext, VerificationDismissal, VerificationRun } from '../types.js';
import { isVerificationRun } from '../types.js';
import { detectToolchains, suggestedWorkingDirectory, suggestionFor, type DetectedToolchain } from './toolchain.js';

/**
 * What a `builtin: declared` Gate is supposed to run, and why it refuses when nothing is declared.
 *
 * The rule this enforces is one line: **a Gate never reports `passed` for a check nobody declared.**
 *
 * Everything else follows from it. The shipped `unit-tests` Gate was `npm test` behind a guard that
 * exited 0 when there was no `package.json`, which meant a Rust, Go or Python project got a Gate
 * that passed having asserted nothing — and with it a `must` Rule whose only enforcement was that
 * Gate, a verification receipt citing its digest, and an archive whose mandatory Gate was empty.
 * The guard was itself a fix: without it those projects got a permanent, false *failure*, because
 * `npm test --if-present` exits 254 rather than the 127 the runner reads as "tool missing". Turning
 * a loud wrong answer into a quiet one is not progress in a governance tool.
 *
 * So the CLI stops answering a question it cannot answer. It has no idea how any given project runs
 * its tests, and now says so: it asks, refuses until told, and records who told it.
 */

export const VERIFICATION_NOT_DECLARED = 'XFORGE_VERIFICATION_NOT_DECLARED';
export const VERIFICATION_TOOLCHAIN_UNCOVERED = 'XFORGE_VERIFICATION_TOOLCHAIN_UNCOVERED';

export interface VerificationPlan {
  gate: string;
  runs: VerificationRun[];
  dismissals: VerificationDismissal[];
  /** Detected markers that neither a run nor a dismissal accounts for. */
  uncovered: DetectedToolchain[];
  /** Everything detected, for message building. */
  detected: DetectedToolchain[];
}

/**
 * What the Manifest declares for one Gate, split by kind.
 *
 * Exported so a caller that only needs "has this been answered" can ask without paying for
 * `resolveVerificationPlan`'s toolchain scan of the working tree — and, more importantly, so it
 * asks the same question this file's own refusal asks, rather than a second one that can drift.
 */
export function verificationEntriesFor(project: ProjectContext, gate: string): { runs: VerificationRun[]; dismissals: VerificationDismissal[] } {
  return entriesFor(project, gate);
}

function entriesFor(project: ProjectContext, gate: string): { runs: VerificationRun[]; dismissals: VerificationDismissal[] } {
  const entries = project.manifest.verification?.[gate] ?? [];
  const runs: VerificationRun[] = [];
  const dismissals: VerificationDismissal[] = [];
  for (const entry of entries) {
    if (isVerificationRun(entry)) runs.push(entry);
    else dismissals.push(entry);
  }
  return { runs, dismissals };
}

/**
 * Whether anything declared accounts for a detected toolchain.
 *
 * The rule turns on how many toolchains there are, because that is what decides whether the
 * question is real:
 *
 * - **One detected marker, and something declared.** Covered. There is nothing to disambiguate, and
 *   asking a single-language project which toolchain its only command covers is the kind of prompt
 *   people learn to click through.
 * - **More than one.** Each marker must be named — by a run's `covers`, or by a dismissal. A
 *   Rust service that grows a `package.json` is exactly the case this exists for, and "the command
 *   they already had probably covers it" is a guess. Guessing is what produced a `unit-tests` Gate
 *   that passed without running anything in the first place.
 *
 * `module` alone cannot answer it: two markers can sit in the same module root, so the run has to
 * name what it covers rather than where it runs.
 */
function isCovered(
  marker: DetectedToolchain,
  runs: VerificationRun[],
  dismissals: VerificationDismissal[],
  detectedCount: number,
): boolean {
  if (dismissals.some((entry) => entry.notApplicable === marker.marker)) return true;
  if (runs.some((run) => run.covers?.includes(marker.marker))) return true;
  return detectedCount === 1 && runs.length > 0;
}

export async function resolveVerificationPlan(project: ProjectContext, gate: string): Promise<VerificationPlan> {
  const { runs, dismissals } = entriesFor(project, gate);
  const detected = await detectToolchains(project);
  const uncovered = runs.length === 0
    /* With nothing declared at all, every marker is "uncovered" trivially and reporting each one
       separately would bury the single thing that matters: this Gate has no declaration. */
    ? []
    : detected.filter((marker) => !isCovered(marker, runs, dismissals, detected.length));
  return { gate, runs, dismissals, uncovered, detected };
}

function suggestionLines(gate: string, detected: DetectedToolchain[]): string {
  if (detected.length === 0) {
    return 'No build-system marker this CLI recognises was found in the project root or any declared module root, so it has no command to suggest. Ask the user how this project runs this check. Do not guess.';
  }
  const lines = detected.map((marker) => {
    const suggestion = suggestionFor(marker, gate);
    const where = suggestedWorkingDirectory(marker);
    return suggestion
      ? `  - ${marker.marker} (${marker.id}) — projects of this shape usually run \`${suggestion.join(' ')}\`${where === '.' ? '' : ` from ${where}`}. Confirm with the user before recording it.`
      : `  - ${marker.marker} (${marker.id}) — this CLI has no suggested ${gate} command for it. Ask the user.`;
  });
  return `Detected build-system markers:\n${lines.join('\n')}\nEvery suggestion above is a starting point for a question, never an answer. Do not guess.`;
}

/**
 * How to record the answer — the command first, because the file is governed.
 *
 * This block used to open with a YAML fragment for `xforge/manifest.yaml` and never mention
 * `xforge verification declare` at all. That made it the only in-band instruction an Agent receives
 * at the one moment a declared Gate refuses, and what it instructed was a hand edit of a file the
 * shipped `protected-manifest` PermissionPolicy guards with `ask` — while asking the editor to
 * invent a `declaredAt` timestamp. A live run followed it and indented the block one level short,
 * after which the governance dispatcher could no longer read the Manifest and denied every
 * subsequent tool call, including the ones that would have repaired it.
 *
 * The command writes the same block, fills `declaredAt` itself, and refuses rather than emitting a
 * Manifest that will not load. The YAML stays below as the shape the command produces, so a reader
 * of the resulting diff still knows what to expect — it is no longer the instruction.
 */
function shapeFor(gate: string): string {
  return [
    'Record the answer with the CLI. It writes the Manifest block, fills declaredAt, and refuses rather than producing a Manifest that would not load:',
    '',
    `  xforge verification declare --gate-name ${gate} --command '["<program>","<arg>"]' --by "<the person who answered>"`,
    '',
    'A toolchain this Gate deliberately does not cover is recorded instead of left unanswered:',
    '',
    `  xforge verification declare --gate-name ${gate} --not-applicable <marker path> --justification "<why this Gate does not cover it>" --by "<the person who answered>"`,
    '',
    "Add --covers '[\"<marker path>\"]' when more than one marker was found and this command answers only some of them, and --module <id> or --working-directory <path> when it runs somewhere other than the project root. --dry-run shows the block without writing it.",
    '',
    'Do not hand-edit xforge/manifest.yaml to do this. It is a governed file, the shipped protected-manifest PermissionPolicy prompts on every write to it, and a malformed one stops the governance dispatcher from reading it at all -- which denies the very tool calls needed to repair it. For reference, the block the command writes is:',
    '',
    '  verification:',
    `    ${gate}:`,
    '      - command: [<program>, <arg>, ...]',
    '        declaredBy: <the person who answered>',
    '        declaredAt: <ISO 8601>',
  ].join('\n');
}

export function notDeclaredNextAction(gate: string, detected: DetectedToolchain[]): NextAction {
  return {
    action: 'declare-verification',
    type: 'maintenance',
    actor: 'human',
    status: 'blocked',
    reason: `Gate ${gate} has no command declared under manifest.verification.${gate}, so there is nothing for it to run and it refuses rather than passing. ${suggestionLines(gate, detected)}\n\n${shapeFor(gate)}`,
  };
}

export function uncoveredNextAction(gate: string, uncovered: DetectedToolchain[]): NextAction {
  return {
    action: 'declare-verification',
    type: 'maintenance',
    actor: 'human',
    status: 'blocked',
    reason: `Gate ${gate} declares commands, but ${uncovered.length === 1 ? 'a build-system marker was found that none of them accounts for' : 'build-system markers were found that none of them accounts for'}. ${suggestionLines(gate, uncovered)}\n\nEither declare a command for it, or record it as not applicable with a justification — both answers are accepted, and once recorded the question is not asked again.\n\n${shapeFor(gate)}`,
  };
}

/** The refusal text written into Gate Evidence, so the reason survives in the record. */
export function notDeclaredReason(gate: string, detected: DetectedToolchain[]): string {
  return [
    `${gate}: no command is declared under manifest.verification.${gate}.`,
    `${gate}: refusing rather than passing. A Gate that reports success without running anything is worse than one that fails, because everything downstream — the Rules it enforces, the verification receipt citing it, the archive requiring it — reads as satisfied.`,
    suggestionLines(gate, detected),
  ].join('\n');
}

export function uncoveredReason(gate: string, uncovered: DetectedToolchain[]): string {
  return [
    `${gate}: ${uncovered.length} detected build-system marker(s) are covered by neither a declared command nor a recorded dismissal: ${uncovered.map((marker) => marker.marker).join(', ')}.`,
    `${gate}: declare a command for each, or record it as notApplicable with a justification. Both answers close the question permanently.`,
  ].join('\n');
}

/**
 * Observations about a run that has just been accepted for the first time.
 *
 * Deliberately not a verdict. Nothing can tell mechanically whether a command really exercises a
 * project's behaviour, so this reports facts and leaves the judgement with the person who declared
 * it: a command that exits successfully in a few milliseconds having printed nothing is what
 * `[echo, ok]` and `[go, build, ./...]` look like, and also what a genuinely tiny suite looks like.
 * Saying so is useful; blocking on it would be guessing again, one level up.
 */
export function suspiciouslyEmpty(durationMs: number, outputBytes: number, exitCode: number | null): string | null {
  if (exitCode !== 0 || durationMs >= 100 || outputBytes > 0) return null;
  return `Declared command succeeded in ${durationMs}ms and produced no output. Most test runners report how many tests ran. Confirm this command actually executes this project's tests.`;
}
