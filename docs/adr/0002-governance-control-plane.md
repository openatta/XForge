# ADR 0002: Protocol 2 governance control plane

- **Status:** accepted
- **Date:** 2026-08-09
- **Supersedes:** ADR 0001 for Rules, Hooks, Flow transitions, approvals, and audit

XForge Protocol 2 separates model guidance (`Rule`) from runtime authorization
(`PermissionPolicy`). Permission effects merge as `deny > ask > allow`; platform
adapters may only project this policy and must report degradation explicitly.

Hooks are split into two planes. Runtime Hooks observe or guard platform events
and are optional defense-in-depth. Workflow Hooks and the built-in workflow
audit are executed by the XForge CLI and remain authoritative even when a
target has no Hook support. Project Runtime Hooks are selected but disabled by
default and platform trust remains a separate user or managed-policy decision.

Stage changes use explicit Transition receipts. Machine Gates, human or signed
external Approval receipts, current revision binding, and audit completeness
are independent requirements. Solid requires one planning approval and one
closing approval. Major requires two role-separated signed approvals at the
implementation and closing boundaries and requires remote audit delivery.
Quick omits planning approval but requires explicit closing approval.

Audit uses a hash-chained local JSONL spool, a committed redacted Change index,
and an optional append-only remote sink. Credentials are referenced only by
environment-variable names. Runtime coverage gaps are represented as facts,
not filled with inferred events.

Protocol 1 projects remain readable in portable mode. Protocol 2 does not treat
legacy Gate output, Markdown approvals, or old Hook configuration as upgraded
evidence.
