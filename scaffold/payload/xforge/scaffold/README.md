# Project-owned Agent assets

These resources are source assets selected by `xforge/manifest.yaml`. Edit them
through normal reviewed project Changes, then run `xforge install --dry-run`,
`xforge install`, and `xforge check`. Generated tool directories are not facts.

The lifecycle and auxiliary Skills are adapted from OpenSpec's MIT-licensed
workflow patterns and changed to consume XForge's `state` protocol,
Constitution, Stage Flows, Gates, and Evidence. Skills and sub-Agent
instructions have an English default plus `_cn` Chinese source variants; all
other Scaffold assets are English. The selected language is projected to the
target's canonical filename. `xforge-archive` remains a delegation entry for
callers that still invoke the legacy Archive Skill name; the underlying
`xforge archive` CLI performs the Spec synchronization and the atomic Change
move under the `xforge-verify` archive-current flow. See `NOTICE`.

The default sub-Agent set is `worker`, `integrator`, and `reviewer`. Main Agent
remains the coordinator. Apply derives optional `work-packages.yaml` at
execution time; XForge validates the DAG and delivery evidence but does not
provide a general Agent runtime.

## Enforcement boundary

`fs.write` PermissionPolicies are an agent-conduct guardrail, not a security
boundary. The runtime bridge matches paths carried in tool-call payloads
(`file_path`/`path` fields and Claude-style patch markers); writes performed
through shell redirection or arbitrary command strings are not reliably
attributed to file paths and are not enforced. Compensating controls: the
`constitution-check` and `structure` Gates, lock-file digests, Git history
review, and the tamper-evident WORM audit chain that records every tool call.
