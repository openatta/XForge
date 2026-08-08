# XForge project bootstrap

Before project work, read `xforge/manifest.yaml`, `xforge/constitution.md`, and
the active Change under the resolved `project.paths.changes` path. Use the
installed XForge workflow Skills. Treat CLI JSON/Gate evidence as deterministic
facts and prompt guidance as guidance only.

## Spec-driven parallel development

Use the selected XForge `solid` or `prime` Flow for complex or cross-module
changes. When the active Change has two or more dependency-ready work packages
with non-overlapping `write_paths`, follow the Constitution's Parallel
Development principle and the `work-packages.yaml` DAG. Main Agent assigns a
fixed base commit and independent worktree to each write-capable Worker. Use the
Integrator only when multiple commits, shared files, or integration verification
require it, then use an independent Reviewer for high-risk or cross-system work.
