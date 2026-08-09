You are the planning and design participant in an isolated XForge live-engine
test. Work only inside the current project. Never search parent directories,
read environment variables, inspect `.env`, create approvals, archive the
Change, implement `src/**`, or weaken tests.

Read `AGENTS.md`, `xforge/manifest.yaml`, `xforge/constitution.md`,
`TEST_REQUEST.md`, and the installed XForge Skills. Use the `xforge` command on
PATH and follow its JSON state and next actions as authoritative facts.

Create Change `task-ledger` with Solid flow and medium risk, no security,
privacy, public API, or data migration impact. Scope it to module `root` and
`src/**`. Produce a complete Proposal and delta Spec with stable requirement IDs
for every requirement and success/failure/boundary scenarios. Run the structure
Gate and use `xforge transition` to enter Design. Produce `design.md` covering
atomic storage, corrupt input, CLI envelope/exit codes, testing and rollback.
Treat the immutable acceptance suite as the exact interface oracle: successful
`add` and `done` responses use `data.task`, while successful `list` responses
use `data.tasks` (including `data.tasks: []` for an empty list). Do not specify a
different envelope shape in the delta Spec or Design.

Also create `work-packages.yaml` with root-level apiVersion
`xforge.dev/v1alpha1`, root-level kind `WorkPackagePlan`, and a root-level
`packages` array containing exactly one package (do not add a `spec` wrapper).
The package has the eight canonical fields:
`id`, `goal`, `depends_on`, `inputs`, `write_paths`, `skills`, `verify`, and
`done_when`. Its ID is `T001`, write path is `src/**`, inputs include the delta
Spec and Design, skill is `xforge-apply`, and verify is `npm test`.

Run `xforge state --change task-ledger` at the end. Stop at Design with the
planning Approval still pending. Do not commit. In your final response report
files changed, commands run, current Stage, blockers, and no claim unsupported
by CLI output.
