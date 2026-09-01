You are the implementation participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, edit `test/**`, edit
`TEST_REQUEST.md`, modify XForge governance assets, transition Stage, archive,
or commit.

Read `AGENTS.md`, `TEST_REQUEST.md`, the active `credential-store` Change, the
installed `xforge-apply` Skill, the latest Transition receipt, and the T001
dispatch receipt. Confirm they show the Apply stage and a bound dispatch. Do
not

What is yours and what is the harness's: implementation is yours, and so is every
`xforge` call the `xforge-apply` Skill prescribes — `state`, `work-package dispatch`,
`work-package draft`, `check`, `transition`. What is never yours is an Approval: external
Approval verification is kept outside the model environment, and `xforge approve` will
refuse here, which is correct rather than a fault. A run driven by hand has no separate
harness process to make the CLI calls for it, so leaving them undone strands the Change at
Apply with no delivery and no route to Verify. Implement only `src/**`
so the pre-existing black-box acceptance suite passes: secrets stored only as
salted `scrypt` hashes, rotation invalidates the old secret immediately (no
grace period), and v1 store files are migrated to v2 in place on first read
without data loss. Use no third-party runtime dependencies — `node:crypto`
and `node:fs` only.

Run `npm test`. If it fails, fix only the implementation and rerun. Stop
after a real passing test run. In your final response report files changed,
test command and result, and the expected remaining XForge next action. Do
not create delivery or Gate Evidence; the external harness does that
independently.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted.
The outline is the contract.
