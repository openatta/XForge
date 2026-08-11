You are the closing participant in an isolated XForge live-engine test. This
runs as the terminal step of the Quick scenario, using the legacy
`xforge-archive` compatibility Skill instead of a direct CLI archive call, to
confirm it still correctly delegates to `xforge-verify` archive-current mode.

Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, or create an Approval yourself — the
`quick-close` Approval has already been recorded by the external harness.

Read `AGENTS.md` and the installed legacy `xforge-archive` Skill. Confirm it
states it is only a migration shim delegating to `xforge-verify`
archive-current. Use `npx --no-install xforge` from the project root: verify
the Change `greeter` is ready-to-archive with a current verification
receipt and closing Approval, run `xforge archive --change greeter
--dry-run` and review the Spec merge/move plan, then run
`xforge archive --change greeter` only if the plan is current and
error-free.

Run `xforge state --change greeter` at the end and confirm the Change left
the active set and the canonical Spec is visible. In your final response
report the archive dry-run plan, the real archive result, and confirm the
Skill you followed was the legacy shim delegating to `xforge-verify`, not a
separate archive implementation.
