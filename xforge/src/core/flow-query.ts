import type { ArtifactState, ExitCondition, FlowStage, StageFlow, TransitionReceipt } from '../types.js';

/**
 * The four questions every reader of a Flow asks, answered once.
 *
 * Each of these was written out by hand wherever it was needed, and the copies had begun to
 * disagree. `stageGates` existed nine times; `currentStageOf` three times, with three different
 * fallbacks for the same absent value (`'unknown'`, `null`, and `undefined`); `structuredExit`
 * twice, one of them a `const` in another module whose comment said "Mirrors `structuredExit`" —
 * an admission that the two had to be kept in step by hand. None of that is style: a Stage's Gate
 * set decides what `check` runs, what a transition blocks on and what `doctor` validates, and
 * nine hand-written copies of it are nine chances for one to be spelled differently from the rest.
 *
 * Deliberately dependency-free apart from the types. Everything here is a projection of a Flow
 * document, computed without touching the filesystem, so any layer may ask — `flow-resolver`, the
 * control plane, `state`, `check` and the Stage commands all do.
 */

/**
 * Every Gate this Stage runs: the ones it declares outright and the ones its exit demands.
 *
 * The two lists are separate in the Flow because they answer different questions — `gates` is what
 * the Stage runs as it works, `exit.gates` is what it may not leave without — and every reader
 * wants the union of them. Deduplicated, because a Flow is free to name one Gate in both and
 * nothing downstream benefits from hearing it twice.
 */
export function stageGates(stage: { gates?: string[]; exit?: { gates?: string[] } | null } | undefined | null): string[] {
  if (!stage) return [];
  return [...new Set([...(stage.gates ?? []), ...(stage.exit?.gates ?? [])])];
}

/** The keys that make a stage `exit` legible to the control plane. */
export const STRUCTURED_EXIT_KEYS = ['conditions', 'gates', 'approvals', 'auditEvents'] as const;

/**
 * A Stage's `exit` in the structured shape, or `{}` when it is written in the shape nothing reads.
 *
 * `flow.schema.json` still accepts the pre-structured form — a bare map of `<key>: <expected>` —
 * and returning it here would hand the control plane a `conditions` map it would then read as
 * Gates. `{}` is the honest answer: the Stage exits as though it declared nothing, which is exactly
 * what happens, and `graphDiagnostics` is what says so out loud rather than silently.
 */
export function structuredExit(stage: Pick<FlowStage, 'exit'>): {
  conditions?: Record<string, ExitCondition>;
  gates?: string[];
  approvals?: string[];
  auditEvents?: string[];
} {
  const exit = stage.exit;
  if (!exit || !STRUCTURED_EXIT_KEYS.some((key) => key in (exit as Record<string, unknown>))) return {};
  return exit;
}

/**
 * The Stage a Change sits at, which is the `to` of its last Transition receipt.
 *
 * `null` when the Flow declares no Stages at all and no receipt has been written — a Flow that
 * cannot be entered. `graphDiagnostics` refuses such a Flow (`propose`, `apply` and `verify` are
 * required), so reaching this is a broken project rather than an ordinary one; `loadFlows` still
 * registers it beside the diagnostics, which is why the case has a value at all.
 *
 * The callers spell that absence three different ways and this does not unify them: the control
 * plane says `unknown` because it must put a string in a receipt-shaped field, the portfolio
 * listing says `null` because a column with no value is the accurate rendering, and `check` says
 * `undefined` because it is choosing a Stage rather than reporting one. They disagree on the word
 * and that is visible — `change.governance.currentStage` and `activeChanges[].stage` can read
 * `"unknown"` and `null` in one reply — but picking one would change what a reply says, so the
 * derivation is shared and the wording is left where it is decided. What is gone is the risk that
 * they disagree on the *derivation*, which is what four hand-written copies made possible.
 */
export function currentStageOf(flow: Pick<StageFlow, 'stages'>, receipts: readonly TransitionReceipt[]): string | null {
  return receipts.at(-1)?.to ?? flow.stages[0]?.id ?? null;
}

/**
 * An Artifact stops holding a Stage when it is written, and equally when this Change was never
 * asked for it.
 *
 * Named once because three call sites decided it independently — a `Set` in the control plane and
 * two hand-spelled pairs elsewhere. `done` and `not-owed` are different statements (see
 * `ArtifactState['status']`) and they answer this one question the same way: there is nothing left
 * to write. Not every `!== 'not-owed'` is this question: `state` filters `not-owed` alone when it
 * trims the payload, which asks whether the Artifact is worth reporting, not whether it is owed.
 */
export function artifactSatisfied(status: ArtifactState['status'] | string | undefined | null): boolean {
  return status === 'done' || status === 'not-owed';
}
