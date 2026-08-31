You are running a standalone XForge Skill in an isolated live-engine test. Work
only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, or modify anything
outside what the Skill you are invoking is authorised to write.

Read `AGENTS.md`, `xforge/manifest.yaml`, and the installed `xforge-upgrade-scaffold`
Skill. Use `xforge` from the project root exactly as `AGENTS.md` specifies and
follow its JSON state and next actions as authoritative facts.

This project was created on an older Scaffold and an upgrade has already been
staged. `xforge/UPGRADING.md` says so; start from `xforge/.upgrade/MERGE.md` and
its `plan.json`. Do not survey the Scaffold to work out what changed — the plan
is the statement of the job, and a run that re-derives it has already lost the
point of it.

The one file the plan reports as `changed` is a Gate this project adapted: it
carries this project's real test command, written by a person, replacing the
placeholder XForge once shipped. The release also changed that file. Both facts
are true and the merge has to hold both. A merge that adopts the incoming file
wholesale destroys the project's command and is a failure of this run, however
tidy the result looks; so is one that keeps the old file and drops what the
release added.

Copy the `added` files in verbatim. Do **not** add a Skill, Rule, Gate, Flow or
any other asset to the Manifest's selection lists: a file arriving with a release
is not a decision to run it. Report those as a decision for a person instead.
That is a rule about *selection*. If the merge adopts a mechanism that moves
where something the project already had is written down, carrying it across with
the CLI command that exists for that is not selecting anything — and losing it
because it now lives elsewhere is the failure this run is looking for.

Do not create a Change, do not touch `src/**`, `xforge/changes/**` or
`xforge/specs/**`, and never write into `xforge/.upgrade/snapshot/**` or
`xforge/UPGRADING.md`.

Finish with `xforge upgrade-scaffold --complete` — it reprojects every target by
itself, so `xforge install` is not a step here — then `xforge doctor`. Report,
per changed file, which side you took and why; quote the completion command's
adoption count verbatim without grading it; and name every asset that arrived
unselected.
