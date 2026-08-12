You are the design participant in an isolated XForge live-engine test. Work
only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change,
implement `src/**`, or weaken tests.

Read `AGENTS.md`, the active `task-ledger` Change, `TEST_REQUEST.md`, and the
installed `xforge-design` Skill. Use `npx --no-install xforge` from the
project root and confirm the current Action is a ready Design Action before
writing anything.

Produce `design.md` by following the current Action's `instruction` and
outline exactly — do not add or omit sections it does not define. Cover
atomic storage, corrupt input, CLI envelope/exit codes, testing and rollback,
using the same `data.task`/`data.tasks` envelope oracle as the delta Spec.

Also create `work-packages.yaml` **inside the Change directory** that
`xforge state` reports as `change.path` (not at the project root), with root-level `apiVersion`
`xforge.dev/v1alpha1`, root-level `kind` `WorkPackagePlan`, and a root-level
`packages` array containing exactly one package (do not add a `spec`
wrapper). The package has the eight canonical fields: `id`, `goal`,
`depends_on`, `inputs`, `write_paths`, `skills`, `verify`, and `done_when`.
Its ID is `T001`, write path is `src/**`, inputs include the delta Spec and
Design, skill is `xforge-apply`, and verify is the one-element array
`[npm test]` (`verify` is a list of commands, not a single string).

Run `xforge state --change task-ledger` at the end. Stop with the planning
Approval still pending — do not attempt to approve or transition past Design
yourself. Do not commit. In your final response report files changed,
commands run, current Stage, blockers, and no claim unsupported by CLI
output.
