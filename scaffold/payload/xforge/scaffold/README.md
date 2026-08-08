# Project-owned Agent assets

These resources are source assets selected by `xforge/manifest.yaml`. Edit them
through normal reviewed project Changes, then run `xforge install --dry-run`,
`xforge install`, and `xforge check`. Generated tool directories are not facts.

The seven lifecycle Skills and four auxiliary Skills are adapted from
OpenSpec's MIT-licensed workflow patterns, translated into Chinese, and changed
to consume XForge's `state` protocol, Constitution, Stage Flows, Gates, and
Evidence. `xforge-archive` remains a one-cycle compatibility shim. See `NOTICE`.

The default sub-Agent set is `worker`, `integrator`, and `reviewer`. Main Agent
remains the coordinator. Apply derives optional `work-packages.yaml` at
execution time; XForge validates the DAG and delivery evidence but does not
provide a general Agent runtime.
