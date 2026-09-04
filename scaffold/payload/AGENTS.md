<!-- XFORGE:BEGIN -->
## XForge

This project is governed by XForge. The CLI is `xforge`, already installed and on PATH.
Never `npx xforge` — npm carries an unrelated package of that name.

On a Change, `xforge stage --change <id>` is the first call: it returns the ready Action with
its `writes`, `requiredSections` and outline, the text of that Action's inputs, the Constitution,
and the diagnostics. Re-run it after each Artifact rather than asking what changed. Outside a
Change, `xforge state` reports project facts and names the active Changes.

Read commands take `--field <dotted.path>`, repeatable, to return one value instead of the whole
envelope; one path that does not resolve fails the call. Chain commands that do not read each
other onto one line — a turn costs far more than a process.

Run the command a reply gives you in `nextActions[].command` or `remedy.commands` rather than
assembling one from a usage string. Treat CLI JSON and Gate evidence as deterministic facts, and
prompt guidance as guidance.

`xforge/XFORGE.md` carries what only one Stage needs: Flow selection and the spec-driven
<!-- XFORGE:END -->
