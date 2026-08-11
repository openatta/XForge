You are the proposing participant in an isolated XForge live-engine test. Work
only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change,
implement `src/**`, or weaken tests.

Read `AGENTS.md`, `xforge/manifest.yaml`, `xforge/constitution.md`,
`TEST_REQUEST.md`, and the installed `xforge-propose` Skill. Use
`npx --no-install xforge` from the project root exactly as `AGENTS.md`
specifies and follow its JSON state and next actions as authoritative facts.

Create Change `credential-store` with Major flow: risk high, security true,
data migration true, privacy and public API false. This classification makes
Major required by Flow policy, not merely eligible — state that explicitly in
the Proposal's Flow choice. Scope it to module `root` and `src/**`. Produce a
complete Proposal (Why, Scope, Non-goals, Actors and success criteria, Flow
choice, critical impacts and rollback) and delta Spec with stable requirement
IDs for REQ-CRED-001, 002, 004, and 005 with full success/failure/boundary/
security scenarios.

For REQ-CRED-003 (rotation), write the requirement's success/failure scenarios
but explicitly do not resolve whether a post-rotation grace period exists —
`TEST_REQUEST.md` deliberately leaves this open. State plainly in the Proposal
that this is an unresolved material question blocking Clarify, and do not
guess an answer.

Run the structure Gate and, once the CLI reports a ready Transition into
Clarify, invoke it. Run `xforge state --change credential-store` at the end
and confirm the current Stage is Clarify. Do not commit. In your final
response report files changed, commands run, current Stage, blockers, and no
claim unsupported by CLI output.
