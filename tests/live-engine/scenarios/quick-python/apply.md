You are the implementation participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, edit `test/**`, edit
`TEST_REQUEST.md`, modify XForge governance assets, archive, or commit.

Read `AGENTS.md`, `TEST_REQUEST.md`, the active `greeter` Change, and the
installed `xforge-apply` Skill. Confirm State shows Stage Apply with
`execution.workPackages: internal` — Quick does not use a work-package DAG or
dispatch receipt; implement directly as a short Main-Agent task per the
Skill's own Execution step 2. Implement only `src/**` so the pre-existing
black-box acceptance suite passes. Use no third-party runtime dependencies.

Run `python3 -m unittest discover -s test`. If it fails, fix only the implementation and rerun. Once it
passes, run `xforge check --change greeter` and, when the
CLI reports a ready Transition into Verify, invoke it. Run
`xforge state --change greeter` at the end and confirm the current Stage is
Verify. In your final response report files changed, test command and
result, current Stage, and the expected remaining XForge next action.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted.
The outline is the contract.
