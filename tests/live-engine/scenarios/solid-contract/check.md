You are the checking participant in an isolated XForge live-engine test. Work
only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change,
implement `src/**`, or weaken tests.

Read `AGENTS.md`, the active `order-cancel` Change, `TEST_REQUEST.md`, and the
installed `xforge-check` Skill. Use `xforge` from the project root and confirm
the current Action is a ready Check Action before writing anything.

Write every Artifact this Stage produces, including each ledger under
`evidence/`. One of them records interface decisions and names the person who
made them — `TEST_REQUEST.md` says who owns this service. Do not invent a
decision or a name; if this Change has nothing to decide, say so in the form the
ledger uses for that.

Run the Stage's Gates after your last write, in one invocation, and report what
they actually said. Then request the Transition the CLI reports as ready.
