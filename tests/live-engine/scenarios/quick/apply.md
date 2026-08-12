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

Run `npm test`. If it fails, fix only the implementation and rerun. Once it
passes, run `npx --no-install xforge check --change greeter` and, when the
CLI reports a ready Transition into Verify, invoke it. Run
`xforge state --change greeter` at the end and confirm the current Stage is
Verify. In your final response report files changed, test command and
result, current Stage, and the expected remaining XForge next action.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted. The
outline is the contract; if something you want to report has no section, put
it inside the closest one rather than inventing a heading. Everything the Change owns — Artifacts, `work-packages.yaml`, and everything
under `evidence/` — lives under the Change directory that `xforge state`
reports as `change.path`, never at the project root. Use the project-relative
path the CLI states (`writes` in a next action, `change.path` otherwise);
never infer a location from a bare file name.
