---
name: xforge-check
description: Perform a pre-implementation semantic review across Major Change Artifacts for completeness, consistency, testability, risk, and feasibility; use for a ready Check Action or a formal Major planning quality gate.
tools: [read, search, write, test]
---

# Invariants

- Run `npx --no-install xforge state --change <id>`, consume only the current-revision ready Check Action, and reread Proposal, Specs, Clarifications, Design, Constitution, Rules, and code facts.
- `xforge-check` performs semantic review; `npx --no-install xforge check` supplies deterministic schema, path, Gate, and Evidence input. Neither replaces the other.
- Governing Artifacts are read-only by default. Report rework instead of silently rewriting upstream content.
- A Check report is LLM Review Evidence, not Gate Evidence; `PASS` cannot satisfy a Machine Gate, Transition, or Approval.
- Gate Evidence binds to the content revision at the moment the Gate runs. Run Gates **after your last write**, in one invocation. Running a Gate, editing an Artifact, then running the next Gate leaves the first stale: every Gate reports `passed` and the Stage still will not close.

# Authority

- Write only the Action-authorized `check-report` and CLI-generated check Evidence.
- Do not write product code, Proposal/Specs/Clarifications/Design, work packages, Gate Evidence, or Archive.

# Execution

1. Check that Proposal and Specs are complete, unambiguous, testable, and have no unresolved material questions.
2. Check Design coverage of Requirements, constraints, trust boundaries, failure cases, compatibility, migration, and rollback.
3. Verify that tests, rollout, monitoring, stop signals, owners, path scope, dependencies, and parallel boundaries match the critical impact.
4. Run `npx --no-install xforge check --change <id>` and use deterministic diagnostics as evidence input.
5. Write blocker, warning, and suggestion findings with Artifact/Requirement location, reason, and `reworkTo` Stage.
6. With `check-report.md` and every Evidence ledger written, run `npx --no-install xforge check --change <id>` once more; it runs the whole Stage Gate set against the final content. Use `--all-gates` when Evidence from earlier Stages must be refreshed too.
7. Refresh State. Request the State-specified rework transition for blockers; without blockers, let CLI Gates and Approval determine whether transition to Apply is ready.

# Evidence

- Report cross-Artifact mappings, CLI results, uncovered Requirements/risks, and feasibility.
- Claim Check satisfied only when blockers are zero and Action `doneWhen` is met.

# Stop and rework

- Stop on material omissions, contradictions, scope drift, untestable Requirements, missing rollback, or path/owner conflicts.
- Return to the earliest affected Propose, Clarify, or Design Stage; do not inspect a nonexistent persistent task plan.

# Judgment calls

- "Passes review" and "the CLI Gate is green" are different claims. A Design can be internally consistent and well-written and still fail Check because a Requirement has no test strategy at all — consistency inside one Artifact does not imply coverage across all of them.
- A missing negative case (the failure path, a boundary, a compatibility break) is easy to miss because nothing in a clean-looking Design points at its own absence. Check what should exist and is not there, not only what exists and is wrong.
