# XForge project bootstrap

Before project work, read `xforge/manifest.yaml`, `xforge/constitution.md`, and
the active Change under the resolved `project.paths.changes` path. Use the
installed XForge workflow Skills. Treat CLI JSON/Gate evidence as deterministic
facts and prompt guidance as guidance only.

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
