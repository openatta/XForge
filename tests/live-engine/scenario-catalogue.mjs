/**
 * Every scenario `run-matrix.mjs` can actually run, as data anything may import.
 *
 * It exists because the coverage matrix could name a scenario that did not exist. `coverage-matrix.yaml`
 * claimed `xforge-scaffold` and `xforge-upgrade-scaffold` were covered by `standalone-scaffold` and
 * `standalone-upgrade-scaffold`; the prompts were there, the runner entries were not, and
 * `check-coverage.mjs` reported `ok: true` because it only ever cross-referenced Skill *names*
 * against the manifest and the Flow stages. Two Skills were documented as covered and had never
 * been run. A coverage report that cannot tell "named" from "runnable" is the one failure mode a
 * coverage report must not have.
 *
 * `run-matrix.mjs` asserts its own `SCENARIOS` keys against this list at startup, so the two cannot
 * drift: adding a scenario to one and not the other stops the runner rather than quietly widening
 * the gap this file was written to close.
 */

/** Scenarios that drive a Flow's whole Stage graph. */
export const FLOW_SCENARIO_IDS = [
  'quick',
  'quick-python',
  'quick-undeclared',
  'solid',
  'solid-rework',
  'major',
];

/**
 * Scenarios that exercise one Skill against a prepared project and no active Change.
 *
 * A standalone Skill has no Flow Stage to reach it from, so nothing in the Flow graph would ever
 * invoke it. Without an entry here such a Skill can only ever be covered on paper.
 */
export const STANDALONE_SCENARIO_IDS = [
  'standalone-scaffold',
  'standalone-architect',
  'standalone-kanban',
  'standalone-upgrade-scaffold',
];

export const SCENARIO_IDS = [...FLOW_SCENARIO_IDS, ...STANDALONE_SCENARIO_IDS];

/**
 * Scenarios that are injected into another scenario's run rather than started on their own.
 *
 * They are genuinely covered — a live model call really does run that Skill's prompt — but they are
 * not selectable with `--scenario`, so a check that demanded they appear in `SCENARIO_IDS` would be
 * demanding the wrong thing. Named here so the coverage check can tell "runs inside another run"
 * apart from "does not run at all", which is exactly the distinction it previously could not make.
 */
export const INJECTED_SCENARIO_IDS = [
  'standalone-status',
  'standalone-status-blocked',
  'standalone-revise',
];

/** Every scenario id the coverage matrix may legitimately name. */
export const COVERABLE_SCENARIO_IDS = [...SCENARIO_IDS, ...INJECTED_SCENARIO_IDS];
