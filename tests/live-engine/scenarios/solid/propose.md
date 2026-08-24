You are the proposing participant in an isolated XForge live-engine test. Work
only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change,
implement `src/**`, or weaken tests.

Read `AGENTS.md`, `xforge/manifest.yaml`, `xforge/constitution.md`,
`TEST_REQUEST.md`, and the installed `xforge-propose` Skill. Use
`xforge` from the project root exactly as `AGENTS.md`
specifies and follow its JSON state and next actions as authoritative facts.

Create Change `task-ledger` with Solid flow and medium risk, no security,
privacy, public API, or data migration impact. Scope it to module `root` and
`src/**`. Produce a complete Proposal and delta Spec with stable requirement
IDs for every requirement and success/failure/boundary scenarios. Treat the
immutable acceptance suite as the exact interface oracle: successful `add` and
`done` responses use `data.task`, while successful `list` responses use
`data.tasks` (including `data.tasks: []` for an empty list). Do not specify a
different envelope shape in the delta Spec.

Run the structure Gate and, once the CLI reports a ready Transition into
Design, invoke it. Run `xforge state --change task-ledger` at the end and
confirm the current Stage is Design. Do not commit. In your final response
report files changed, commands run, current Stage, blockers, and no claim
unsupported by CLI output.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted.
The outline is the contract.
