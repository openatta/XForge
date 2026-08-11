You are the reporting participant in an isolated XForge live-engine test. Work
only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, or modify anything under `src/**` or
`xforge/**` — `xforge-kanban` only reads `git log` and writes its own report.

Read `AGENTS.md` and the installed `xforge-kanban` Skill. Use
`npx --no-install xforge` from the project root only if the Skill's own
Execution steps call for a read command; `xforge-kanban` mainly reads `git
log` directly, not XForge Change/Flow state, and does not require an active
Change.

Produce the Markdown activity dashboard the Skill describes (per-contributor
commits, lines, active days; a weekday x hour heatmap; a feat/fix/other
breakdown) from this repository's actual Git history, however sparse it is.
Do not fabricate contributors, commits, or numbers not derivable from `git
log`; a thin history is a valid, correctly reported result.

In your final response report the output file path and confirm every number
in it traces to a real `git log` command you ran.
