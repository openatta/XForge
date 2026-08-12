You are the clarifying participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change,
implement `src/**`, or weaken tests.

Read `AGENTS.md`, the active `credential-store` Change, `TEST_REQUEST.md`, the
immutable acceptance suite under `test/**`, and the installed `xforge-clarify`
Skill. Use `npx --no-install xforge` from the project root and confirm the
current Action is a ready Clarify Action before writing anything.

The Proposal left one material question unresolved: after `rotate`, should
`verify` still accept the old secret for some grace period? Read the
acceptance suite as the authoritative source for the actual required
behavior — do not decide from general security preference alone; cite the
specific test that pins the answer. Record the question, its impact
(security, compatibility), your decision, and the acceptance-suite source in
`clarifications.md`.

The Stage exit is decided by a machine-readable ledger, not by that prose:
also write `evidence/conditions/materialQuestions.yaml` with one entry per
material question carrying `question`, `impact`, `decision`, a named
`decidedBy`, and an ISO 8601 `decidedAt`. An undecided entry keeps the Stage
closed; a sentence claiming resolution does not open it. Then revise the Proposal and the
REQ-CRED-003 delta Spec requirement so the resolved behavior (no grace
period; rotation invalidates the old secret immediately) is stated
explicitly, not left implicit.

Run the structure Gate and, once the CLI reports a ready Transition into
Design, invoke it. Run `xforge state --change credential-store` at the end
and confirm the current Stage is Design and no material question remains
unresolved. Do not commit. In your final response report files changed,
commands run, current Stage, blockers, and no claim unsupported by CLI
output.

Every Markdown Artifact you write must use exactly the `##` section set its
Flow `artifacts[].outline` defines — no extra section, none omitted. The
outline is the contract; if something you want to report has no section, put
it inside the closest one rather than inventing a heading. Everything the Change owns — Artifacts, `work-packages.yaml`, and everything
under `evidence/` — lives under the Change directory that `xforge state`
reports as `change.path`, never at the project root. Use the project-relative
path the CLI states (`writes` in a next action, `change.path` otherwise);
never infer a location from a bare file name.
