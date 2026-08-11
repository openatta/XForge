You are the verification participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, edit implementation or
tests, transition Stage, archive, or commit.

Read `AGENTS.md`, `TEST_REQUEST.md`, the complete active `greeter` Change, and
the installed `xforge-verify` Skill. Confirm State shows Stage Verify. Do not
run `npx --no-install xforge` in this phase because external closing Approval
verification is kept outside the model environment. Run `npm test` as an
independent verification. If it fails, document the failure and stop without
changing implementation or tests.

If it passes, create a complete `assurance.md` that maps every Requirement ID
to real test evidence and discusses completeness, correctness, coherence,
risk and findings. Create `evidence/verification-receipt.yaml` recording
passed status, current Flow/Stage, Git HEAD, test command, and no
work-package delivery reference (Quick has none). This is review/verification
metadata, not Machine Gate Evidence. Stop without running check or
transition; the external harness will commit these artifacts, generate
current-revision Machine Gate Evidence, obtain closing Approval, and archive.
Any contradiction between the delta Spec, immutable tests, and implementation
is a blocker even when `npm test` passes: record a failed verdict, do not
claim archive readiness, and request rework instead of downgrading it to a
warning.
