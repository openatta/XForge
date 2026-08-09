# @xforge/cli

Protocol 2 implementation of the XForge project CLI, including state, managed
projection, Rule/PermissionPolicy adapters, runtime Hook bridges, guarded
Transitions, signed Approval receipts, Gates, Audit, work-package dispatch and
atomic Archive.
JSON is the default output. The CLI is offline once declared dependencies and
project assets are present. Active Changes may add an eight-field
`work-packages.yaml`; `work-package dispatch` binds execution to State/Policy/Audit,
while `check` verifies Git write boundaries and re-runs package verification
into bounded Evidence without becoming an Agent runtime. Protocol 1 projects
remain readable in Portable mode.
