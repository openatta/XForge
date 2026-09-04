# XForge bootstrap

This project is governed by XForge. The CLI is `xforge`, already installed and on PATH; never `npx xforge`.

On a Change, `xforge stage --change <id>` is the first call: it returns the ready Action with its `writes`, `requiredSections` and outline, the text of that Action's inputs, the Constitution, and the diagnostics. Outside a Change, `xforge state` reports project facts and names the active Changes. Read commands take `--field <dotted.path>`, repeatable, to return one value instead of the whole envelope.

Use the installed `xforge-*` Skills, take commands from `nextActions[].command`, and treat only matching CLI/Gate evidence as enforced facts. `xforge/XFORGE.md` carries Flow selection and the parallel development policy.
