---
name: xforge-clarify
description: Resolve material ambiguity in a Major Change that affects scope, design, compatibility, risk, or acceptance, and atomically update authorized upstream specifications; use for a ready Clarify Action or formal planning rework.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# Invariants

- **Enter** with `xforge stage --change <id>`. It returns where the Change stands, the ready Action with its `writes`, `requiredSections`, `instruction` and `outline`, the text of that Action's `inputs`, the Constitution, and the diagnostics — in one reply. Do not open those inputs separately; they arrived. Re-run it after each Artifact rather than asking what changed. It also carries what this Stage declares — what it produces, its Gates, its exit conditions, its rework routes — so `xforge/flows/*.yaml` does not need opening: the Flow file is 400 lines and the Action already holds the outline you would go there for.
- Resolve facts from code, Specs, Rules, and Proposal first; ask only a small set of project-unanswerable questions that materially affect the result.
- Keep Clarifications and authorized Proposal/delta Spec updates in one consistent revision. Any unresolved material question remains blocking.

# Authority

- Write exactly the two Artifacts the Clarify Stage `produces` — `clarifications.md` and `evidence/conditions/materialQuestions.yaml` — plus the existing Proposal/delta Spec paths the Action's `revises` field explicitly lists.
- The material-questions ledger is Agent-authored: no CLI command writes it, and the Stage cannot exit without it. It sits under `evidence/` and is still not Gate Evidence — "Gate Evidence" means the `evidence/*.json` files that only `xforge check` writes, which are never hand-written or edited. The ledger is an Artifact the control plane reads, on the same footing as the two ledgers `xforge-check` authors.
- Do not write Design, Check reports, code, canonical Specs, Gate Evidence, tasks, or Archive, and do not make material decisions for the user.

# Execution

1. Reread all Action inputs and list unknowns that affect scope, compatibility, risk, implementation boundaries, or acceptance.
2. Investigate project-answerable questions; ask the minimum decision set for the rest.
3. Write `clarifications.md`, and record the same set as machine-decidable entries in `evidence/conditions/materialQuestions.yaml` exactly as that Action's `instruction` and `outline` define it. **The Stage exits on that ledger, never on the prose.** Then synchronize the confirmed decisions into the Proposal and delta Specs, keeping Requirements and Scenarios testable.
4. Re-run `xforge stage --change <id>`, confirm `materialQuestions: resolved`, then run `xforge advance --change <id>`: it checks structure and policy and takes the Transition only if nothing refuses. Where more than one Transition is ready it asks; name the one the typed nextAction gives with `--to`.

# Evidence

- Cite a user decision or project fact for each decision and identify the Requirements/Scenarios updated.
- Claim Clarify satisfied only when State reports its exit conditions satisfied.

# Stop and rework

- Stop with `request-decision` when the user has not decided, inputs conflict, scope expands, revision changes, or more authority is required.
- On `condition:materialQuestions:stale-<ids>`, this Change went back past Clarify and has returned, so the named entries were decided against a Proposal or delta Specs that were rewritten afterwards. **Put each named question to whoever decides it again, against the current Artifacts**, then record the answer and a new `decidedAt`. A decision that still holds is confirmed, not assumed — and moving the timestamp without asking records an answer nobody gave, which is exactly what `decidedBy` and that field exist to prevent. Entries the rework did not reach keep their original `decidedAt`; only the ones the CLI names are stale.
- If later work reveals a new material ambiguity, invalidate downstream work and return through `xforge-revise` to Clarify.

# Judgment calls

- Not every open question is material. A question that would change the Design's approach or an acceptance boundary is material; a question whose answer only changes an implementation detail belongs in Apply, not here — escalating the latter delays planning without improving it.
- The absence of a stated question is not evidence the project already agreed on the answer. Silence usually means nobody decided, not that the obvious choice was chosen — treat an unstated but consequential default the same as an open question.
