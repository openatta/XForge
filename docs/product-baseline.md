# Product baseline

The authoritative v0.1.0 product and architecture baseline is
[XFORGE_PRODUCT_SPEC.md](XFORGE_PRODUCT_SPEC.md). It is intentionally kept as
one fact source rather than duplicated here.

The accepted and implemented Protocol 2 governance model is documented in
[governance-control-plane-design.md](governance-control-plane-design.md). It
defines the separation of Rules, PermissionPolicy, Runtime/Workflow Hooks,
Gates, Approvals, Evidence, Audit, and Transitions. ADR 0002 supersedes ADR 0001
for that scope; `@xforge/cli 0.4.1` implements Protocol 2 while retaining
Protocol 1 Portable-read migration.
