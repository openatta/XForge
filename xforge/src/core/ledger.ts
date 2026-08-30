/**
 * The shape every governance ledger evaluator returns, and the one place its rules are stated.
 *
 * Three modules evaluate an Agent-authored YAML ledger and hand back a verdict —
 * `check-findings.ts`, `constitution-check.ts`, `verification-receipt.ts` — and all three arrived at
 * nearly the same shape independently. Nearly is the problem. They agreed on `status` and
 * `problems`; two of them grew a `warnings` list and the third never did; and the two that had one
 * were both read by a Gate runner that collected the warnings and then dropped them, so a
 * disclosure both this codebase and the `xforge-check` Skill describe in prose had never once
 * reached a reader.
 *
 * That is what a pattern copied three times produces: not one bug, but three different ways to
 * leave the same hole. Stating the contract once means a fourth ledger cannot invent a fourth.
 *
 * The contract:
 *
 * - **`problems` decide the verdict.** A ledger fails when it has any and passes when it has none.
 *   Nothing else may set `status`, which is why `verdict()` computes it rather than accepting it.
 * - **`warnings` never decide anything, and must still be reported.** They exist for the case where
 *   a check ran and could not conclude — a `resolvedBy` accepted because the repository records no
 *   identities yet, a citation pointing at a file that is not there. A warning that reaches nobody
 *   is indistinguishable from a check that was never written.
 * - **A passing ledger says what it found anyway.** `ledgerReport` is the one renderer, so "passed,
 *   and here is what you should still look at" cannot be forgotten in one caller and remembered in
 *   another.
 */

export interface LedgerVerdict {
  status: 'passed' | 'failed';
  /** Reasons this ledger is not acceptable. Non-empty means `failed`; the two cannot disagree. */
  problems: string[];
  /**
   * Findings that never change the verdict and always have to be visible.
   *
   * Typically "this check could not conclude" rather than "this is wrong" — the distinction that
   * makes a provisional pass readable as provisional instead of as a real one.
   */
  warnings: string[];
}

/**
 * A verdict from what was found, rather than a status somebody set.
 *
 * The three evaluators each assembled `status: problems.length === 0 ? 'passed' : 'failed'` at their
 * own return statement, which is a rule three copies could drift on. It has one home now.
 */
export function verdict(problems: string[], warnings: string[] = []): LedgerVerdict {
  return { status: problems.length === 0 ? 'passed' : 'failed', problems, warnings };
}

/**
 * Keys an entry carries that nothing reads.
 *
 * Every one of these evaluators pulls named fields off a parsed YAML object and ignores the rest, so
 * a misspelled key is not an error — it is silence. `resolveBy` instead of `resolvedBy` produces a
 * finding that looks resolved in the file and is counted open by the Gate, with a message about a
 * missing attribution and nothing pointing at the six characters that caused it. The third field
 * report spent a human signature on that class of confusion.
 *
 * A warning, never a verdict: an entry with a stray key is not unusable, and promoting it would
 * refuse ledgers that were valid before anybody thought to check. The value is the sentence, not the
 * refusal.
 */
function unknownKeys(entry: unknown, known: readonly string[]): string[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  return Object.keys(entry as Record<string, unknown>).filter((key) => !known.includes(key)).sort();
}

/** Edit distance, capped: anything past `limit` is "not a near miss" and the exact number is unused. */
function distance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = left[row - 1] === right[column - 1]
        ? previous[column - 1]!
        : 1 + Math.min(previous[column]!, current[column - 1]!, previous[column - 1]!);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * The known key an unknown one was probably meant to be, or `null`.
 *
 * Case-insensitive equality first, then one or two edits — enough for `resolveBy`, `resolved_by` and
 * `References`, and short of guessing. A suggestion that is wrong is worse than none here, because
 * the reader is being told what to type.
 */
function nearestKey(key: string, known: readonly string[]): string | null {
  const lowered = key.toLowerCase();
  const exact = known.find((candidate) => candidate.toLowerCase() === lowered);
  if (exact) return exact;
  const limit = key.length <= 4 ? 1 : 2;
  let best: { key: string; score: number } | null = null;
  for (const candidate of known) {
    const score = distance(lowered, candidate.toLowerCase(), limit);
    if (score > limit) continue;
    if (!best || score < best.score) best = { key: candidate, score };
  }
  return best?.key ?? null;
}

/**
 * The warning an entry with stray keys earns, phrased so the reader can act without re-reading the
 * schema. Returns an empty list when there is nothing to say, so callers can spread it.
 */
export function unknownKeyWarnings(entry: unknown, known: readonly string[], where: string): string[] {
  return unknownKeys(entry, known).map((key) => {
    const suggestion = nearestKey(key, known);
    return `${where} carries an unknown key "${key}"${suggestion ? `; did you mean "${suggestion}"?` : '.'} Nothing reads it, so whatever it says has no effect. Known keys: ${[...known].join(', ')}.`;
  });
}

/**
 * What a Gate prints for a ledger it evaluated.
 *
 * `stdout` on a pass, `stderr` on a failure, and the warnings either way — because a Gate's output
 * is the only thing a reader gets, and dropping the warnings is exactly the defect this module
 * exists to make unrepeatable.
 *
 * A failure kept them out for longer than the pass did, which is backwards: the warning is most
 * often the sentence that explains the failure. `resolveBy:` instead of `resolvedBy:` fails with
 * "marked resolved but names no resolvedBy" and warns "unknown key \"resolveBy\"; did you mean
 * \"resolvedBy\"?" -- and only the half that does not say what to do was printed.
 */
export function ledgerReport(headline: string, result: LedgerVerdict): { stdout: string; stderr: string } {
  if (result.status !== 'passed') {
    return { stdout: '', stderr: [...result.problems, ...result.warnings.map((warning) => `warning: ${warning}`)].join('\n') };
  }
  return {
    stdout: [headline, ...result.warnings.map((warning) => `warning: ${warning}`)].join('\n'),
    stderr: '',
  };
}
