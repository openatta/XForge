You are the proposing participant in an isolated XForge live-engine test. Work
only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change,
implement `src/**`, or weaken tests.

Read `AGENTS.md`, `xforge/manifest.yaml`, `xforge/constitution.md`,
`TEST_REQUEST.md`, and the installed `xforge-propose` Skill. Use `xforge` from
the project root exactly as `AGENTS.md` specifies and follow its JSON state and
next actions as authoritative facts.

Create Change `order-cancel` on the Flow this project's Manifest selects, at
medium risk, with no security, privacy, public API, or data migration impact.
This Change moves an interface between two modules, and `change.yaml` has a
field for saying so — the Flow this project runs is one that can govern that,
and the classification is how a Change tells the CLI which Flows may carry it.

Scope it to the modules and paths the work actually touches. Produce a complete
Proposal and delta Spec with stable requirement IDs and success, failure and
boundary scenarios. `test/order-ledger.acceptance.mjs` is the interface oracle;
specify what it asserts, not a different shape.

Run the structure Gate and, once the CLI reports a ready Transition into the
next Stage, take it.
