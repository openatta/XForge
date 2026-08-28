# XForge project bootstrap

Before project work, read `xforge/manifest.yaml` and `xforge/constitution.md`.

For the active Change under the resolved `project.paths.changes` path, run
`xforge stage-bundle --change <id>` first. It names which of that Change's files
moved since the current Stage began and which did not, so the reading that
follows covers what changed rather than everything — six Stages re-reading the
same sixty kilobytes is most of what fills a session. Read in full every file it
lists under `READ IN FULL`, and open a file it vouched for whenever you need to
check its wording: the digest says the text is the one the previous Stage read,
not that reading it is forbidden. It vouches for nothing while the Change has
uncommitted edits, and always lists the Constitution and this Stage's own outputs
to be read whole.

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

Either way the version is enforced, not assumed: the CLI compares itself
against `xforge/manifest.yaml` on every run and refuses to write when they
disagree (`XFORGE_CLI_IDENTITY_MISMATCH`). Report that diagnostic rather than
attempting to satisfy it.

## Spec-driven parallel development

Use XForge `quick` when delivery speed is the priority and the Change is low
risk, bounded, and reversible; use `solid` for stable routine delivery; use
`major` for significant, high-risk, cross-system, or critical-impact changes.
When the active Change has two or more dependency-ready work packages
with non-overlapping `write_paths`, follow the Constitution's Parallel
Development principle and the `work-packages.yaml` DAG. Main Agent assigns a
fixed base commit and independent worktree to each write-capable Worker. Use the
Integrator only when multiple commits, shared files, or integration verification
require it, then use an independent Reviewer for Major or cross-system work.
Only activate parallel Workers when the target runtime reports native Agent
support; otherwise execute the packages sequentially and report the degradation.
