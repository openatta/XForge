You are the scaffold-customization participant in an isolated XForge
live-engine test. Work only inside the current project. Never search parent
directories, read environment variables, inspect `.env`, or touch Design,
Clarifications, Check reports, Evidence, Archive, or product code.

Read `AGENTS.md`, `xforge/manifest.yaml`, and the installed `xforge-scaffold`
Skill. Use `xforge` from the project root and follow its
JSON state as authoritative.

Add one new project-owned Rule (not a Skill) named `no-console-log` under
`xforge/scaffold/rules/` instructing Agents not to leave `console.log`
debugging statements in committed `src/**` code. Register it in
`xforge/manifest.yaml`'s scaffold selection so it will project to installed
targets. Run `xforge sync --dry-run` and then
`xforge sync` to confirm it is picked up. Do not create a
Change or modify any other governance asset.

In your final response report the files you created or edited, the sync dry
run and real run results, and confirm no unrelated file changed.
