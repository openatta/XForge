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
 * What a Gate prints for a ledger it evaluated.
 *
 * `stdout` on a pass, `stderr` on a failure, and the warnings attached to the pass — because a
 * passing Gate's output is the only thing a reader gets, and dropping the warnings there is exactly
 * the defect this module exists to make unrepeatable.
 */
export function ledgerReport(headline: string, result: LedgerVerdict): { stdout: string; stderr: string } {
  if (result.status !== 'passed') return { stdout: '', stderr: result.problems.join('\n') };
  return {
    stdout: [headline, ...result.warnings.map((warning) => `warning: ${warning}`)].join('\n'),
    stderr: '',
  };
}
