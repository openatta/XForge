You are the continuation participant in an isolated XForge live-engine test.
This runs as a checkpoint immediately after the external harness recorded the
T001 work-package delivery, which the implementation participant could not see:
while it was working, the package was still `running` and leaving Apply was
correctly blocked.

Work only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create or fabricate an Approval, edit
`test/**`, write product code, or commit.

Read `AGENTS.md` and the installed `xforge-continue` Skill. Run
`npx --no-install xforge state` to find the active Change, then
`npx --no-install xforge state --change <id>` and confirm from CLI output that
work package T001 is `succeeded`. Without being told which Skill applies,
determine the next legal Action from the CLI's own `nextActions`.

If that next Action is a Stage Transition an Agent may perform, perform it with
`npx --no-install xforge transition --change <id> --to <stage>`. If it is
blocked on a human or external Approval, stop without performing it and say so;
never route around a boundary you cannot legally cross.

In your final response state T001's status verbatim from CLI output, the next
legal Action, whether you performed it, and the resulting current Stage.
