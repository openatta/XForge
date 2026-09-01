You are the implementing participant in an isolated XForge live-engine test.
Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, archive the Change, or
weaken tests.

Read `AGENTS.md`, the active `order-cancel` Change, its Proposal, delta Spec,
Design and interface delta, and the installed `xforge-apply` Skill.

Implement the change in `src/**` so that `test/order-ledger.acceptance.mjs`
passes unmodified. The interface delta declares what the service now exposes;
`src/api/openapi.json` is what the service actually serves, and the two are
meant to agree. Keep the declared dependency direction: `api` may read `store`,
never the reverse.

Do not edit anything under `xforge/contracts/` — that record is advanced by
archiving this Change, not by writing to it.

Then take the ready Transition.
