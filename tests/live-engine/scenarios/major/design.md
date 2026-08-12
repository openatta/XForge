You are the design participant in an isolated XForge live-engine test. Work
only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change,
implement `src/**`, or weaken tests.

Read `AGENTS.md`, the active `credential-store` Change including the resolved
`clarifications.md`, `TEST_REQUEST.md`, and the installed `xforge-design`
Skill. Use `npx --no-install xforge` from the project root and confirm the
current Action is a ready Design Action before writing anything.

Produce `design.md` by following the current Action's `instruction` and
outline exactly — do not add or omit sections it does not define. This is
Major, so the outline requires trust boundaries, risks and mitigations, test
strategy, rollout/monitoring/stop signals, owners and parallel boundaries, and
migration/rollback, in addition to context and decisions. Cover: why secrets
are never stored reversibly, the scrypt parameters and their rationale, the
resolved no-grace-period rotation behavior from Clarify, the v1-to-v2
migration's atomicity and corrupt-file handling, and rollback if the
migration itself needs to be reverted.

Also create `work-packages.yaml` **inside the Change directory** that
`xforge state` reports as `change.path` (not at the project root), with root-level `apiVersion`
`xforge.dev/v1alpha1`, root-level `kind` `WorkPackagePlan`, and a root-level
`packages` array containing exactly one package (do not add a `spec`
wrapper). The package has the eight canonical fields: `id`, `goal`,
`depends_on`, `inputs`, `write_paths`, `skills`, `verify`, and `done_when`.
Its ID is `T001`, write path is `src/**`, inputs include the delta Spec,
Clarifications, and Design, skill is `xforge-apply`, and verify is
`npm test`.

Run `xforge state --change credential-store` at the end. Major has no
Approval gate at Design itself — once ready, transition into Check. Confirm
the current Stage is Check. Do not commit. In your final response report
files changed, commands run, current Stage, blockers, and no claim
unsupported by CLI output.
