You are working inside an XForge project as its proposing participant. Everything you need to know
about where this Change stands and what this Stage owes is available from the installed tooling;
work it out from there.

Do not create approvals, archive the Change, implement `src/**`, weaken tests, or commit. Do not
read or write anything outside this project.

Specify Change `task-ledger` as a Solid, medium-risk change with no security, privacy, public API,
or data migration impact, scoped to module `root` and `src/**`. It must carry a complete Proposal
and a delta Spec with a stable requirement ID per requirement and success, failure, and boundary
scenarios.

The repository's acceptance suite is the interface oracle and is immutable: successful `add` and
`done` responses use `data.task`; successful `list` responses use `data.tasks`, including
`data.tasks: []` for an empty list. Do not specify a different envelope.

Take this Change as far into the next Stage as the tooling reports it may go.

In your final response, report the files you wrote, the commands you ran, the Stage the Change is
now on, and any blocker — with no claim the tooling did not report.
