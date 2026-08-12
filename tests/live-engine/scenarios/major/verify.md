You are the verification participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, edit implementation or
tests, run `xforge check`, transition Stage, archive, or commit.

Read `AGENTS.md`, `TEST_REQUEST.md`, the complete active `credential-store`
Change, the installed `xforge-verify` Skill, work-package delivery, and the
latest Transition receipt. Confirm the receipt shows the Verify stage. Do not
run `npx --no-install xforge` in this phase because external closing Approval
verification is kept outside the model environment. Run `npm test` as an
independent verification. If it fails, document the failure and stop without
changing implementation or tests.

If it passes, create a complete `assurance.md` that maps every Requirement ID
to real test evidence, explicitly confirms the resolved rotation behavior and
the migration requirement were both honored, and discusses completeness,
correctness, coherence, residual security risk, and findings. Create
`evidence/verification-receipt.yaml` recording passed status, current
Flow/Stage, Git HEAD, test command, and the existing work-package delivery
reference. This is review/verification metadata, not Machine Gate Evidence.
Stop without running check or transition; the external harness will commit
these artifacts, generate current-revision Machine Gate Evidence, obtain
closing Approval, and archive. Any contradiction between the delta Spec,
Clarifications, Design, immutable tests, and implementation is a blocker even
when `npm test` passes: record a failed verdict, do not claim archive
readiness, and request rework instead of downgrading it to a warning.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted. The
outline is the contract; if something you want to report has no section, put
it inside the closest one rather than inventing a heading. Everything the Change owns — Artifacts, `work-packages.yaml`, and everything
under `evidence/` — lives under the Change directory that `xforge state`
reports as `change.path`, never at the project root. Use the project-relative
path the CLI states (`writes` in a next action, `change.path` otherwise);
never infer a location from a bare file name.
