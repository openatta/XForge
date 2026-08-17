You are running a standalone XForge Skill in an isolated live-engine test. Work
only inside the current project. Never search parent directories, read
environment variables, inspect `.env`, create approvals, or modify anything
outside what the Skill you are invoking is authorised to write.

Read `AGENTS.md`, `xforge/manifest.yaml`, `xforge/constitution.md`,
`TEST_REQUEST.md`, and the installed `xforge-architect` Skill. Use `xforge` from
the project root exactly as `AGENTS.md` specifies and follow its JSON state and
next actions as authoritative facts.

This project has no `xforge/architecture.md`. Run `xforge doctor` first and
report what it says about that — the absence is a suggestion, not a finding, and
a run that treats it as a problem to be silenced has misread it.

Then write the file, converging by questioning rather than by reading the whole
tree. `TEST_REQUEST.md` states what this project is and what it deliberately does
not do; treat it as the answers a project owner would give, and ask nothing it
already answers. The seeded `test/**` suite is the interface oracle and tells you
what the module boundaries actually are.

Hold to the Skill's budget: under 50 lines, at most six decisions. If the project
does not have six decisions worth recording, write fewer — a decision earns its
place by being one whose reversal would touch several modules, and padding the
file to fill a budget is the failure this budget exists to prevent.

Every `Why` must be something this project stated, not something you inferred to
make a decision look complete. Where you cannot source a reason, say so in your
report instead of writing one.

Do not create a Change, do not touch `src/**`, and do not modify any Scaffold
asset. Finish by reporting the file's line count, its decision count, and any
question you would have asked a person if one were available.
