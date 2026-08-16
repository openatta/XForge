You are the revising participant in an isolated XForge live-engine test. This
runs as a checkpoint inside the Solid scenario, right after Propose and
before Design — the harness has just committed an upstream change to
`TEST_REQUEST.md` (a new requirement, `REQ-TASK-006`, was added) that the
already-written Proposal and delta Spec do not yet reflect.

Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change,
implement `src/**`, or weaken tests.

Read `AGENTS.md`, the active `task-ledger` Change, the current
`TEST_REQUEST.md`, and the installed `xforge-revise` Skill. Use
`xforge` from the project root and confirm the current
Action is a ready Revise Action before writing anything.

Diff the current `TEST_REQUEST.md` against the existing Proposal and delta
Spec, identify exactly what changed (`REQ-TASK-006`), and update the Proposal
and delta Spec to incorporate it with the same rigor (stable requirement ID,
success/failure/boundary scenarios) as the existing requirements — without
rewriting unrelated requirements or silently expanding scope beyond the new
requirement.

Run the structure Gate. Run `xforge state --change task-ledger` at the end
and confirm the Change is still consistent and ready for Design to proceed.
Do not commit, transition, or begin Design yourself. In your final response
report exactly what changed, files edited, current Stage, and no claim
unsupported by CLI output.
