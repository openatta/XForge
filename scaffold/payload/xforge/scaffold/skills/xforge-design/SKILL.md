---
name: xforge-design
description: Produce a governed technical design for a Solid or Major Change, including alternatives, failure boundaries, and verification; use for a ready Design Action after Proposal, Specs, and required Clarifications are satisfied.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# Invariants

- Run `xforge state --change <id> --field nextActions --field diagnostics --field change.governance --field change.nextArtifact --field change.path`, consume only the current-revision ready Design Action, and reread every Action input.
- Design explains HOW, decisions, and boundaries. It does not repeat Proposal or become a file-by-file task list or persistent plan.
- Constitution, Rules, current architecture, and Specs constrain the design; summarize their implications instead of copying them mechanically.

# Authority

- Write only the Artifact paths the Action returns. On a contract-governed Flow that is two documents, the Design and the `contract-delta`, and neither is `xforge/contracts/` itself.
- Do not modify Proposal, Specs, Clarifications, product code, Check reports, Evidence, tasks, or Archive. Return upstream changes as rework.

# Execution

1. Model the current system, target behavior, integration points, data, and interface boundaries.
2. Record major decisions, viable alternatives and rejection reasons, failure modes, compatibility, migration, and rollback.
3. Follow the current Action's Design artifact `instruction` and outline exactly — Solid vs Major depth (e.g. Major's trust boundaries, risks and mitigations, test strategy, rollout, monitoring, stop signals, owner, and parallel boundaries) is already expressed there. Do not add or omit sections the Action does not define.
4. When the Action lists a `contract-delta` Artifact, write it too. It names the module interfaces this Change moves, addressed by the contract element id the baseline already uses — read them with `xforge contract list`, and never retype one from memory: a mistyped id does not fail, it merges as a new element beside the one you meant to change — and it is the only place a Change may say an interface changed — `xforge/contracts/` is the record of what was already agreed, and archive is what merges a delta into it. Editing the baseline in place leaves every other package building against something nothing agreed to. A section with nothing in it gets `(none)`, which is an assertion; a blank one is an omission. A Stage that declares `contract-lint` cannot pass until this project has recorded a command for it — `xforge verification declare --gate-name contract-lint --command '[...]' --by <person>` — because a declared Gate refuses rather than passing when nothing is declared, and hand-editing the Manifest is both governed and how one live run made it unreadable.
5. Refresh State and run `xforge check --change <id>`; fix only Design-authorized structural issues, then invoke the typed ready Transition to Check. No shipped Flow collects an approval at the Design exit — `planning-solid` and `implementation-major` are both collected at the Check exit — so do not wait here for a receipt nothing will request, and do not try to approve for this Stage: `xforge approve` refuses a transition no policy governs.

# Evidence

- Read `xforge/architecture.md` when it exists, and say how this Change stands against each decision it touches — within it, or departing from it with a stated reason. When the design needs a decision *changed*, write the proposal into the Design Artifact you own and stop for a human. Do not write `evidence/conditions/architectureDeltas.yaml` yourself: that entry names a `decidedBy`, and an Agent filling in a human's name records an authorisation nobody gave — the exact thing the ledger exists to catch. A human authorises and invokes `xforge-architect`, which is the only writer of the architecture file and its ledger. When the file does not exist, say so once and proceed: it is a project that has not written its architecture down, not a project in violation.
- Map each major decision to a Requirement, project constraint, or code fact and state the verifiable result.
- Report coverage, residual risk, and the next legal Action against Action `doneWhen`.
- If a project's own Flow does declare an approval at the Design exit (none of the shipped Flows do), run `xforge check --change <id>` and put its `XFORGE_RECONCILE_*` entries to the user before they sign. Each is one stated difference; do not reword it.

# Stop and rework

- Stop on material ambiguity, Spec conflict, unknown trust boundary, irreversible impact, or an upstream change requirement.
- Hand upstream issues to Clarify/Revise and never silently expand Scope in Design.

# Judgment calls

- The cheapest-looking alternative is not automatically the right one to reject last. Write down why a simpler approach was rejected even when it seems obviously insufficient — "obviously insufficient" is exactly the kind of claim a reviewer six months later cannot verify without the reasoning that produced it.
- Compatibility and rollback are two different questions. A design that is backward-compatible in its data format can still be irreversible in practice if the migration is one-directional — check both independently instead of treating "compatible" as implying "reversible."
