# XForge project bootstrap

Before project work, read `xforge/manifest.yaml` and `xforge/constitution.md`.
Before reading an active Change's files, run `xforge stage-bundle --change <id>`
and read in full everything it lists under `READ IN FULL`.

Use the installed XForge workflow Skills. Treat CLI JSON/Gate evidence as
deterministic facts and prompt guidance as guidance only.

## Invoking the CLI

XForge is designed to be operated by an Agent, not typed ad hoc by a human. A
human or CI installs the CLI once (`npm install -g @xforge/cli@<version>`);
every subsequent operation is this Agent running `xforge ...` exactly as each
Skill's Invariants specify.

If `xforge` is not found, stop and report it. **Never fall back to
`npx xforge`**: npm carries an unrelated package of that name, and npx will
fetch and run it. Never install the CLI to work around a missing command
either — which version this project runs is a decision recorded in
`xforge/manifest.yaml`, not one to make from a shell.

A project may instead pin the CLI locally, in which case it is invoked as
`npx --no-install xforge ...` because the binary lives in `node_modules/.bin`
rather than on `PATH`. Follow whichever form this project already uses; do not
convert between them.

Each `xforge` call is a process, not a session: it re-resolves the project from disk every time
and keeps nothing between runs. Two consequences, and the second is the one that costs.

Reading the same thing twice is cheap for XForge and expensive for you — not because the CLI
re-reads it, but because every answer it prints stays in your context for the rest of the session.
So ask for what you are about to act on. `--field <path>` takes one value out of the Envelope and
prints nothing else, and repeats: `xforge state --change <id> --field nextActions --field change`
is one call returning two values. Six sections are left out of `state` until `--include` asks for
them, and each says so where it would have been.

`check` takes `--field` too. Its reply carries the structure report, the resolved Change, the Gate
selection, the work-package selection and `gates`; a Stage acting on the verdict wants `gates`, and
`xforge check --change <id> --field gates --field diagnostics` leaves the rest behind. Ask for the
diagnostics with it, always: an empty `gates` is what a Stage that declares none looks like, and what
a Stage whose Evidence went stale looks like, and only the diagnostics tell those apart — a live run
read `[]` as "nothing to say" and was one call away from transitioning on stale Evidence. Note what that does not do: each
entry in `gates` carries its own Evidence — the verify command's whole stdout, the digests, the
timestamps — so this narrows the reply to the part you act on rather than making it small.

A refusal answers the same way, narrowed to what you asked for plus why it failed, so
`--field diagnostics` after one is a few lines rather than the whole project.

`--field` takes a dotted path, not only a top-level name: `--field change.governance.currentStage`
prints one string. And it is all or nothing — one name that does not resolve fails the call and
returns none of the values, so a guessed path costs the whole reply. Where a Change is blocked is
`state`, not `check`: `--field change.governance.readyTransitions`, whose entries carry `blockedBy`.

And chain the calls that do not read each other. A governed Change is dozens of CLI invocations,
and a turn costs far more than a process, so `xforge check --change <id> && xforge transition
--change <id> --to <stage>` belongs on one line rather than in two turns. This is safe because
every command decides for itself: `transition` evaluates readiness and refuses when a condition is
unmet, exactly as it would have alone. Chain them when the second does not need you to *read* the
first — and keep them separate when it does.

Either way the version is enforced, not assumed: the CLI compares itself
against `xforge/manifest.yaml` on every run and refuses to write when they
disagree (`XFORGE_CLI_IDENTITY_MISMATCH`). Report that diagnostic rather than
attempting to satisfy it.

## Spec-driven parallel development

Use XForge `quick` when delivery speed is the priority and the Change is low
risk, bounded, and reversible; use `solid` for stable routine delivery; use
`major` for significant, high-risk, cross-system, or critical-impact changes.
None of the three can carry a Change that moves an interface between modules:
set `classification.moduleContract` truthfully and all three refuse it with
`XFORGE_FLOW_TOO_WEAK`, naming an eligible Flow if this project has adopted
one. The refusal is the key working — answering `false` to clear it is the one
move that puts an interface change on a Flow with no step for it.
When the active Change has two or more dependency-ready work packages
with non-overlapping `write_paths`, follow the Constitution's Parallel
Development principle and the `work-packages.yaml` DAG. Main Agent assigns a
fixed base commit and independent worktree to each write-capable Worker. Use the
Integrator only when multiple commits, shared files, or integration verification
require it, then use an independent Reviewer for Major or cross-system work.
Only activate parallel Workers when the target runtime reports native Agent
support; otherwise execute the packages sequentially and report the degradation.
