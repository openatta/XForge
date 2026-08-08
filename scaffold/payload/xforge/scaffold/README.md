# Project-owned Agent assets

These resources are source assets selected by `xforge/manifest.yaml`. Edit them
through normal reviewed project Changes, then run `xforge install --dry-run`,
`xforge install`, and `xforge check`. Generated tool directories are not facts.

The five `xforge-*` workflow Skills are adapted from OpenSpec's MIT-licensed
default workflow Skills and changed to consume XForge's `state` protocol,
Constitution, Flows, Gates, and Evidence. See `NOTICE` in this directory.

The default sub-Agent set is `worker`, `integrator`, and `reviewer`. Main Agent
remains the coordinator. Parallel execution is described by an optional
`work-packages.yaml` in the active Change; XForge validates that plan and its
delivery evidence but does not provide a general Agent runtime.
