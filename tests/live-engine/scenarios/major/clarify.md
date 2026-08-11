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
(security, compatibility), your decision, the acceptance-suite source, and
`Status: resolved` in `clarifications.md`. Then revise the Proposal and the
REQ-CRED-003 delta Spec requirement so the resolved behavior (no grace
period; rotation invalidates the old secret immediately) is stated
explicitly, not left implicit.

Run the structure Gate and, once the CLI reports a ready Transition into
Design, invoke it. Run `xforge state --change credential-store` at the end
and confirm the current Stage is Design and no material question remains
unresolved. Do not commit. In your final response report files changed,
commands run, current Stage, blockers, and no claim unsupported by CLI
output.
