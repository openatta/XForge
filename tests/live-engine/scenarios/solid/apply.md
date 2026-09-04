You are the implementation participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, edit `test/**`, edit
`TEST_REQUEST.md`, modify XForge governance assets, archive, or commit.

Read `AGENTS.md`, `TEST_REQUEST.md`, the active `task-ledger` Change, the
installed `xforge-apply` Skill, the latest Transition receipt, and the T001
dispatch receipt. Confirm they show the Apply stage and a bound dispatch.

What is yours and what is the harness's: implementation is yours, and so is every
`xforge` call the `xforge-apply` Skill prescribes — `state`, `work-package dispatch`,
`work-package draft`, `check`, `transition`. What is never yours is an Approval: external
Approval verification is kept outside the model environment, and `xforge approve` will
refuse here, which is correct rather than a fault. A run driven by hand has no separate
harness process to make the CLI calls for it, so leaving them undone strands the Change at
Apply with no delivery and no route to Verify. Implement only `src/**` so
the pre-existing black-box acceptance suite passes. Use no third-party runtime
dependencies.

Run `npm test`. If it fails, fix only the implementation and rerun. A passing test
run is not the end of this Stage: `xforge-apply` says the Stage ends when a
transition receipt exists, and taking that Transition is yours. Stop once the CLI
reports the Change has left Apply. In your final response report files changed, test
command and result, and the Stage the Change now stands in. Record the delivery with `xforge work-package draft` rather than hand-writing it, and
never hand-write Gate Evidence — `xforge check` is the only thing that writes those.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted.
The outline is the contract.
