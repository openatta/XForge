---
name: xforge-archive
description: Compatibility entry that delegates an explicit archive request to the xforge-verify archive-current flow, which drives the `xforge archive` CLI (Spec synchronization, terminal governance re-check, and the atomic Change move); use when the legacy Archive Skill is invoked for an explicit archive request.
allowed-tools: Read Grep Glob Bash(npx:*)
---

# Invariants

- Run `npx --no-install xforge state --change <id>` and resolve one active Change without guessing readiness or Evidence freshness.
- This Skill is a delegation entry. `xforge-verify` archive-current owns all archive semantics, verification, and authority; the actual Spec synchronization and atomic Change move are performed by the `xforge archive` CLI under that flow.

# Authority

- Do not write Specs or Evidence contents, or move the Change directly; the `xforge archive` CLI performs those writes.
- Delegate to archive-current only for an explicit archive request; use verify-only when the user requested verification only.
- Agents cannot create Closing Approval. A human or configured external provider must supply a current-revision receipt.

# Execution

1. Query State and explain that the legacy entry is merged into `xforge-verify`.
2. Follow `xforge-verify` archive-current: confirm the Stage is `ready-to-archive`, run `npx --no-install xforge audit verify --change <id>`, check current Gate/Approval/Audit receipts, run the archive dry-run, and archive only after confirmation.
3. Refresh State and report the final result.

# Evidence

- Cite only the verification receipt, Gate Evidence, dry-run plan, and CLI archive transaction result.

# Stop and rework

- Stop on missing explicit authority, stale receipt, failed Gate, or dry-run diagnostics. Never bypass Verify.
