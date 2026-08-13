---
name: xforge-archive
description: Compatibility entry that delegates an explicit archive request to xforge-verify archive-current mode; use only while callers still invoke the legacy Archive Skill. This Skill itself no longer synchronizes Specs or moves a Change directly — it delegates both to xforge-verify's archive-current mode, which invokes the CLI's archive engine to do so.
allowed-tools: Read Grep Glob Bash(npx:*)
---

# Invariants

- Run `npx --no-install xforge state --change <id>` and resolve one active Change without guessing readiness or Evidence freshness.
- This Skill is only a migration shim. `xforge-verify` archive-current owns all archive semantics, verification, and authority.

# Authority

- Do not write Specs, Evidence, or Archive or move the Change directly.
- Delegate to archive-current only for an explicit archive request; use verify-only when the user requested verification only.
- Agents cannot create Closing Approval. A human or configured external provider must supply a current-revision receipt.

# Execution

1. Query State and explain that the legacy entry is merged into `xforge-verify`.
2. Follow `xforge-verify` archive-current: require ready-to-archive, verify Audit and current Gate/Approval/Audit receipts, preview archive, and archive only after confirmation.
3. Refresh State and report the final result.

# Evidence

- Cite only the verification receipt, Gate Evidence, dry-run plan, and CLI archive transaction result.

# Stop and rework

- Stop on missing explicit authority, stale receipt, failed Gate, or dry-run diagnostics. Never bypass Verify.
