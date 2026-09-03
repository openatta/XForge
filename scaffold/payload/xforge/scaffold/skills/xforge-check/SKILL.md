---
name: xforge-check
description: Perform a pre-implementation semantic review across a Solid or Major Change's Artifacts for completeness, consistency, testability, risk, and feasibility; use for a ready Check Action or a formal planning quality gate.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# Invariants

- **Enter** with `xforge stage --change <id>`. It returns where the Change stands, the ready Action with its `writes` and `requiredSections`, and under `owes` every Artifact this Stage still owes with its `instruction` and `outline`, the text of that Action's `inputs`, the Constitution, and the diagnostics — in one reply. Do not open those inputs separately; they arrived. Re-run it after each Artifact rather than asking what changed. It also carries what this Stage declares — what it produces, its Gates, its exit conditions, its rework routes — so `xforge/flows/*.yaml` does not need opening: the Flow file is 400 lines and the Action already holds the outline you would go there for.
- `xforge-check` performs semantic review; `xforge check` supplies deterministic schema, path, Gate, and Evidence input. Neither replaces the other.
- Governing Artifacts are read-only by default. Report rework instead of silently rewriting upstream content.
- A Check report is LLM Review Evidence, not Gate Evidence; `PASS` cannot satisfy a Machine Gate, Transition, or Approval.
- Gate Evidence binds to the content revision at the moment the Gate runs. Run Gates **after your last write**, in one invocation. Running a Gate, editing an Artifact, then running the next Gate leaves the first stale: every Gate reports `passed` and the Stage still will not close.

# Authority

- Write exactly the Artifacts the Check Stage `produces`: `check-report.md`, `evidence/check-findings.yaml`, and `evidence/constitution-check.yaml`. Both ledgers are Agent-authored — no CLI command writes them, and the Stage cannot exit without them.
- On a contract-governed Flow the Stage also cannot exit until the `contractDecisions` exit condition is satisfied, and `evidence/conditions/contractDecisions.yaml` is a third Agent-authored ledger of the same kind. It lives under `evidence/` and is still not Gate Evidence.
- Do not write product code, Proposal/Specs/Clarifications/Design, work packages, or Archive.
- "Gate Evidence" means the `evidence/*.json` files that only `xforge check` writes (`structure.json`, `check-findings.json`, `constitution-check.json`, `contract-compat.json`, …). Never hand-write or edit those. The two YAML ledgers above are Artifacts the Gates read, not Gate Evidence.

# Execution

1. Check that Proposal and Specs are complete, unambiguous, testable, and have no unresolved material questions.
2. Check Design coverage of Requirements, constraints, trust boundaries, failure cases, compatibility, migration, and rollback.
3. Verify that tests, rollout, monitoring, stop signals, owners, path scope, dependencies, and parallel boundaries match the critical impact.
4. Use the diagnostics `xforge stage` already returned as evidence input. Do not run `xforge check` for them: with no Gate selection it also executes every work package's declared `verify` command — a ten-package plan is dozens of external commands and minutes of wall time — and the Gate results it produces here are worthless anyway, because the ledgers those Gates read do not exist yet. The one `check` this Stage needs is the one at step 9, after the writes.
5. Write `evidence/check-findings.yaml` as the Artifact's `instruction` and `outline` under `owes` define it. Those two carry the field set, the empty-list case, and what the `resolvedBy` identity is checked against; this Skill does not restate them. What it owes you is the review itself: every blocker you record here is a Stage the Change goes back to, so record the ones you would defend and leave out the ones you would not.
6. Write `evidence/constitution-check.yaml` as the Artifact's `instruction` and `outline` under `owes` define it — one entry per principle, each citing something machine-locatable. Answer every principle against what this Change actually did, and treat `not-applicable` as a claim you have to justify rather than a way past a principle you have not thought about.
7. On a contract-governed Flow, write `evidence/conditions/contractDecisions.yaml`: one entry per interface change that needs a person to decide it — typically each breaking change the `contract-delta` declares — with exactly the four field names `question`, `decision`, `decidedBy` and `decidedAt`. There are no aliases: `resolvedBy` and `approvedBy` belong to the two ledgers above and are not read here, and a misspelled key is silent, because nothing suggests a correction for this file the way it does for the findings ledger. `decidedAt` must parse as a date, and `decidedBy` must match an approver on one of this Change's receipts or one of its Git authors — the same bar, and the same provisional pass while the Change has neither. **Do not decide these yourself.** An entry naming a person is that person's authorisation; writing one for them records an authorisation nobody gave. Put the question to the user and write what they answer. When this Change has no interface decision to make, `entries: []` is the whole file, and it is an assertion rather than an omission. The CLI reports a shortfall verbatim as `condition:contractDecisions:<reason>` — `undecided-N` names the entries, `ledger-missing-expected-resolved` means the file is not there at all.
8. The Check Stage on a contract-governed Flow also runs `contract-compat`, which is a declared Gate: it refuses until this project has recorded a command with `xforge verification declare --gate-name contract-compat --command '[...]' --by <person>`. That refusal reads in `blockedBy` as `gate:contract-compat:failed`, indistinguishable from a real failure — read the diagnostic code, not the block, and never hand-edit `xforge/manifest.yaml` to fix it.
8b. **Write `check-report.md` last, after both ledgers.** Its `Gates and evidence` section records what `xforge check` actually reported, and the Gates are evaluated against the ledgers — so a report written before them cites results that do not exist yet, and correcting it afterwards moves the content revision and stales the Gates it just cited. The order that terminates is: ledgers, then one `check`, then the report quoting it, then the final `check` at step 9. Four measured runs found this by trial; the one that wrote the report first spent three rounds of edit-and-recheck getting out of it.
9. With `check-report.md` and the ledgers written, run `xforge check --change <id>` once more; it re-runs and refreshes the whole current-Stage Gate set against the final content. `--all-gates` also runs Gates belonging to Stages the Change has not reached yet, which cannot pass and is rarely what you want mid-Stage. To refresh one Gate rather than the set — which is what `XFORGE_GATE_EVIDENCE_STALE` asks for after a later write staled it — run `xforge check --change <id> --gate <gate-id>`.
10. Refresh State. Request the State-specified rework transition for blockers; without blockers, let CLI Gates and Approval determine whether `xforge transition --change <id> --to apply` is ready.

# Evidence

- Report cross-Artifact mappings, CLI results, uncovered Requirements/risks, and feasibility.
- Claim Check satisfied only when blockers are zero and Action `doneWhen` is met.
- Before the approval that lets implementation start, run `xforge check --change <id>` and put its `XFORGE_RECONCILE_*` entries to the user. Each states a difference between this Stage's own ledgers and the files — answer them, do not argue with them. Do not restate them in your own words: they are already one line each, and rewording a stated difference is how it becomes an opinion.

# Stop and rework

- Stop on material omissions, contradictions, scope drift, untestable Requirements, missing rollback, or path/owner conflicts.
- Return to the earliest affected Propose, Clarify, or Design Stage **through `xforge-revise`**, which is the sanctioned way to change an upstream Artifact: it revises the affected Artifacts consistently and lets the digest chain invalidate the downstream Evidence that relied on them. Editing an upstream Artifact directly leaves the rest of the Change silently disagreeing with it.
- Do not inspect a nonexistent persistent task plan.

# Judgment calls

- "Passes review" and "the CLI Gate is green" are different claims. A Design can be internally consistent and well-written and still fail Check because a Requirement has no test strategy at all — consistency inside one Artifact does not imply coverage across all of them.
- A missing negative case (the failure path, a boundary, a compatibility break) is easy to miss because nothing in a clean-looking Design points at its own absence. Check what should exist and is not there, not only what exists and is wrong.
