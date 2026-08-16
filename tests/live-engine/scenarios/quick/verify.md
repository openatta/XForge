You are the verification participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, edit implementation or
tests, transition Stage, archive, or commit.

Read `AGENTS.md`, `TEST_REQUEST.md`, the complete active `greeter` Change, and
the installed `xforge-verify` Skill. Confirm State shows Stage Verify. Do not
run `xforge approve`, `transition`, or `archive` in this
phase, because closing Approval and Stage movement are kept outside the model
environment; `xforge state` and `xforge check` are yours to run and the Skill
requires them. Run `npm test` as an independent verification. If it fails,
document the failure and stop without changing implementation or tests.

If it passes, create a complete `assurance.md` that maps every Requirement ID
to real test evidence and discusses completeness, correctness, coherence,
risk and findings. Write it before the receipt: it is an Artifact, so it moves
the content revision the receipt has to name. Then run `xforge check` to produce current-revision Machine Gate Evidence, and create
`evidence/verification-receipt.yaml` recording passed status, current
Flow/Stage, `contentRevision` from `xforge state`, Git HEAD, and test command.
Its `gates` list carries exactly the Gates this Stage declares and nothing else;
Quick has no work packages, so `workPackageDeliveries` does not appear at all.
The receipt is review/verification metadata, not Machine Gate Evidence, and
never restates a Gate's findings as its own. Stop without transitioning;
the external harness will commit these artifacts, obtain closing Approval, and
archive.
Any contradiction between the delta Spec, immutable tests, and implementation
is a blocker even when `npm test` passes: record a failed verdict, do not
claim archive readiness, and request rework instead of downgrading it to a
warning.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted. The
outline is the contract; if something you want to report has no section, put
it inside the closest one rather than inventing a heading. Everything the Change owns — Artifacts, `work-packages.yaml`, and everything
under `evidence/` — lives under the Change directory that `xforge state`
reports as `change.path`, never at the project root. Use the project-relative
path the CLI states (`writes` in a next action, `change.path` otherwise);
never infer a location from a bare file name.
