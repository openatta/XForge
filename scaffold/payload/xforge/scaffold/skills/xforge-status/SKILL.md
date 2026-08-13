---
name: xforge-status
description: Explain xforge state as readable progress for a Change or Requirement; use when the user asks what is done, why work is blocked, which packages remain, whether Evidence is current, or whether Verify/Archive is ready.
allowed-tools: Read, Grep, Glob, Bash(npx:*)
---

# Invariants

- Run `npx --no-install xforge state`, resolve one Change, then run `npx --no-install xforge state --change <id>`. State is the only progress source of truth.
- Remain strictly read-only; do not maintain a second progress ledger or continue/fix/check off work incidentally.

# Authority

- Query, filter, and explain State, work packages, deliveries, diagnostics, and Evidence freshness.
- Do not modify project files, generate Evidence, execute a ready Action, or archive.

# Execution

1. Resolve Change ID and request a choice if multiple Changes or Requirement ownership is ambiguous.
2. Report Flow, current Stage/revision, ready/blocked Transitions, pending Approvals, Rule coverage, active Policy/Hook coverage, Audit chain/remote pending/gaps, work-package lifecycle/deliveries, Evidence freshness, and Verify/Archive readiness.
3. Give the next legal Action, owning Skill, and reason it is or is not ready.
4. Mark Requirement progress as heuristic when deterministic ID indexing is unavailable; do not over-infer from Markdown search.

# Evidence

- Bind every progress conclusion to one State revision and concrete diagnostics/Evidence paths.

# Stop and rework

- Stop and report missing information when IDs are ambiguous, State errors, or Evidence cannot be verified. Never fill gaps from chat memory.
