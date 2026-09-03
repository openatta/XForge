---
name: xforge-design
description: Produce a governed technical design for a Solid or Major Change, including alternatives, failure boundaries, and verification; use for a ready Design Action after Proposal, Specs, and required Clarifications are satisfied.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# Invariants

- **Enter** with `xforge stage --change <id> --content full`. It returns where the Change stands, the ready Action with its `writes` and `requiredSections`, and under `owes` every Artifact this Stage still owes with its `instruction` and `outline`, the text of that Action's `inputs`, the Constitution, and the diagnostics — in one reply. Do not open those inputs separately; they arrived — and `--content full` is what makes that true on entry. The default withholds an Artifact that has not moved since the Stage was entered and offers its digest instead, which is the right trade for a session that already read the file and the wrong one for a session starting cold: the digest is paid for and the file is read anyway. Re-run it as plain `xforge stage --change <id>` after each Artifact rather than asking what changed — by then you have seen them, and the default is the right trade again. It also carries what this Stage declares — what it produces, its Gates, its exit conditions, its rework routes — so `xforge/flows/*.yaml` does not need opening: the Flow file is 400 lines and the Action already holds the outline you would go there for.
- Design explains HOW, decisions, and boundaries. It does not repeat Proposal or become a file-by-file task list or persistent plan.
- Constitution, Rules, current architecture, and Specs constrain the design; summarize their implications instead of copying them mechanically.

# Authority

- Write only the Artifact paths the Action returns. On a contract-governed Flow that is two documents, the Design and the `contract-delta`, and neither is `xforge/contracts/` itself.
- Do not modify Proposal, Specs, Clarifications, product code, Check reports, Evidence, tasks, or Archive. Return upstream changes as rework.

# Execution

1. Model the current system, target behavior, integration points, data, and interface boundaries.
2. Record major decisions, viable alternatives and rejection reasons, failure modes, compatibility, migration, and rollback.
3. Follow the Design Artifact's `instruction` and outline under `owes` exactly — Solid vs Major depth (e.g. Major's trust boundaries, risks and mitigations, test strategy, rollout, monitoring, stop signals, owner, and parallel boundaries) is already expressed there. Do not add or omit sections the Action does not define.
4. When the Action lists a `contract-delta` Artifact, write it as that Artifact's `instruction` and `outline` under `owes` define it — they carry the element-id form, how to read the ids, and what an empty section says. One thing is not in them because it is about this project rather than this Artifact: a Stage that declares `contract-lint` cannot pass until the project has recorded a command with `xforge verification declare --gate-name contract-lint --command '[...]' --by <person>`, because a declared Gate refuses rather than passes when nothing is declared. Do not hand-edit the Manifest to get past it.
5. Refresh State and run `xforge check --change <id>`; fix only Design-authorized structural issues, then invoke the typed ready Transition to Check. No shipped Flow collects an approval at the Design exit — `planning-solid` and `implementation-major` are both collected at the Check exit — so do not wait here for a receipt nothing will request, and do not try to approve for this Stage: `xforge approve` refuses a transition no policy governs.

# Evidence

- Read `xforge/architecture.md` when it exists, and say how this Change stands against each decision it touches — within it, or departing from it with a stated reason. When the design needs a decision *changed*, write the proposal into the Design Artifact you own and stop for a human. Do not write `evidence/conditions/architectureDeltas.yaml` yourself: that entry names a `decidedBy`, and an Agent filling in a human's name records an authorisation nobody gave. Nothing will stop you: no Flow declares this ledger as an exit condition, so no Gate reads it and no transition blocks on it. That is the reason to keep the rule, not a reason to relax it — the entry is the only trace the decision leaves, and a fabricated one is indistinguishable from a real one forever after. A human authorises and invokes `xforge-architect`, which is the only writer of the architecture file and its ledger. When the file does not exist, say so once and proceed: it is a project that has not written its architecture down, not a project in violation.
- Map each major decision to a Requirement, project constraint, or code fact and state the verifiable result.
- Report coverage, residual risk, and the next legal Action against Action `doneWhen`.
- If a project's own Flow does declare an approval at the Design exit (none of the shipped Flows do), run `xforge check --change <id>` and put its `XFORGE_RECONCILE_*` entries to the user before they sign. Each is one stated difference; do not reword it.

# Stop and rework

- Stop on material ambiguity, Spec conflict, unknown trust boundary, irreversible impact, or an upstream change requirement.
- Hand upstream issues to Clarify/Revise and never silently expand Scope in Design.

# Judgment calls

- The cheapest-looking alternative is not automatically the right one to reject last. Write down why a simpler approach was rejected even when it seems obviously insufficient — "obviously insufficient" is exactly the kind of claim a reviewer six months later cannot verify without the reasoning that produced it.
- Compatibility and rollback are two different questions. A design that is backward-compatible in its data format can still be irreversible in practice if the migration is one-directional — check both independently instead of treating "compatible" as implying "reversible."
