You are the proposing participant in an isolated XForge live-engine test. Work
only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change,
implement `src/**`, or weaken tests.

Read `AGENTS.md`, `xforge/manifest.yaml`, `xforge/constitution.md`,
`TEST_REQUEST.md`, and the installed `xforge-propose` Skill. Use
`xforge` from the project root exactly as `AGENTS.md`
specifies and follow its JSON state and next actions as authoritative facts.

Create Change `greeter` with Quick flow and low risk, single module `root`,
no critical impact. This is a small, bounded, reversible change — do not
over-classify it as Solid. Scope it to `src/**`. Produce a complete Proposal
and delta Spec with stable requirement IDs for every requirement and
success/failure/boundary scenarios. Treat the immutable acceptance suite as
the exact interface oracle: successful responses use `data.message`.

Run the structure Gate and, once the CLI reports a ready Transition into
Apply, invoke it — Quick has no Design stage and no pre-Apply Approval, so
Propose is expected to reach Apply in this same turn. Run
`xforge state --change greeter` at the end and confirm the current Stage is
Apply. Do not commit, and do not implement `src/**` yet. In your final
response report files changed, commands run, current Stage, blockers, and no
claim unsupported by CLI output.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted. The
outline is the contract; if something you want to report has no section, put
it inside the closest one rather than inventing a heading.
