You are the status-reporting participant in an isolated XForge live-engine
test. This runs as a safe, read-only checkpoint inside the Quick scenario,
right after Apply and before Verify — it must not change anything the rest
of that run depends on.

Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, or write any file — `xforge-status` is
read-only.

Read `AGENTS.md` and the installed `xforge-status` Skill. Then:

1. Run `npx --no-install xforge state` with no `--change` and report the
   in-flight portfolio from `activeChanges`: every un-archived Change, its
   Flow, its current Stage, and its risk. Do not rebuild that list by walking
   `xforge/changes` yourself.
2. Run `npx --no-install xforge state --change greeter` and explain, in plain
   language grounded only in that JSON, the current Stage, what Artifacts
   exist, what Gates have run, and what the next legal Action is.

Do not guess at anything the CLI output does not state, and do not perform the
next Action — name it and stop.

In your final response give the portfolio table, that explanation, and confirm
no file was written.
