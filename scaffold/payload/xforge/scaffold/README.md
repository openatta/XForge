# Project-owned Agent assets

These resources are source assets selected by `xforge/manifest.yaml`. Edit them
through normal reviewed project Changes, then run `xforge install --dry-run`,
`xforge install`, and `xforge check`. Generated tool directories are not facts.

The lifecycle and auxiliary Skills are adapted from OpenSpec's MIT-licensed
workflow patterns and changed to consume XForge's `state` protocol,
Constitution, Stage Flows, Gates, and Evidence. Skills and sub-Agent
instructions have an English default plus `_cn` Chinese source variants; all
other Scaffold assets are English. The selected language is projected to the
target's canonical filename. `xforge-archive` remains a one-cycle compatibility
shim. See `NOTICE`.

The default sub-Agent set is `worker`, `integrator`, and `reviewer`. Main Agent
remains the coordinator. Apply derives optional `work-packages.yaml` at
execution time; XForge validates the DAG and delivery evidence but does not
provide a general Agent runtime.

## Templates

`flows/` holds Flow definitions that ship unselected. Nothing loads them: `xforge/flows/` is read by
listing it, so a Flow placed there is a Flow this project runs, and one nobody selected is reported
as unused for as long as it sits there. A template is copied into `xforge/flows/` by the project
adopting it. Each one carries its own adoption steps at the top of the file.

`flows/solid-contract.yaml` is Solid with a contract baseline: an interface delta declared per
Change, four declared Gates that check it, and a decision ledger for breaking changes. Adopting it
also means selecting `rules/interfaces-are-contract-governed.yaml` and the four `contract-*` and
`module-boundaries` Gates, which likewise ship unselected.

## Enforcement boundary

`fs.write` PermissionPolicies (such as `policies/protected-files.yaml`) are an
agent-conduct guardrail, not a security boundary. The runtime bridge decides on
the paths a tool call carries in its own payload — an editor tool's
`file_path`/`path` field, or `*** Add|Update|Delete File:` patch markers inside
a command string. A write performed through shell redirection or an arbitrary
command (`cat > xforge/manifest.yaml`, `tee`, `cp`, a script that opens the file
itself) is not reliably attributable to a file path: a `shell` call is matched
only against a policy's `match.commands` globs on the raw command string, so
those writes are not enforced.

The compensating controls are after-the-fact and structural: the
`constitution-check` and `structure` Gates, the per-resource digests in
`xforge/lock.yaml`, Git history review, and the tamper-evident WORM audit chain
that records every dispatched tool call. Treat a policy deny as something an
honest Agent respects, and rely on those controls to detect what it did not.
