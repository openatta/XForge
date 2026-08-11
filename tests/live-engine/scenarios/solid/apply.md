You are the implementation participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, edit `test/**`, edit
`TEST_REQUEST.md`, modify XForge governance assets, transition Stage, archive,
or commit.

Read `AGENTS.md`, `TEST_REQUEST.md`, the active `task-ledger` Change, the
installed `xforge-apply` Skill, the latest Transition receipt, and the T001
dispatch receipt. Confirm they show the Apply stage and a bound dispatch. Do not
run `npx --no-install xforge` in this phase because external Approval
verification is kept outside the model environment. Implement only `src/**` so
the pre-existing black-box acceptance suite passes. Use no third-party runtime
dependencies.

Run `npm test`. If it fails, fix only the implementation and rerun. Stop after a
real passing test run. In your final response report files changed, test command
and result, and the expected remaining XForge next action. Do not create
delivery or Gate Evidence; the external harness does that independently.
