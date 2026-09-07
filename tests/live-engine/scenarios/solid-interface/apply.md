You are the implementing participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change, or
weaken tests.

Read `AGENTS.md`, the active `order-cancel` Change and every Artifact it
carries, and the installed `xforge-apply` Skill.

Implement the change in `src/**` so that `test/order-ledger.acceptance.mjs`
passes unmodified. `src/api/openapi.json` is what the service actually serves,
and it is meant to agree with whatever this Change declared it would expose.
Keep the declared dependency direction: `api` may read `store`, never the
reverse.

Do not edit anything under `xforge/contracts/` — that record is advanced by
archiving this Change, not by writing to it.

Then take the ready Transition.
