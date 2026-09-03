---
name: xforge-revise
description: Revise existing Change planning Artifacts consistently and invalidate affected downstream state and evidence; use when requirements, scope, or decisions change, or Check/Apply discovers an invalid upstream assumption.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(xforge:*)
---

# Invariants

- **Enter** with `xforge stage --change <id>`. It returns where the Change stands, the ready Action with its `writes` and `requiredSections`, and under `owes` every Artifact this Stage still owes with its `instruction` and `outline`, the text of that Action's `inputs`, the Constitution, and the diagnostics — in one reply. Do not open those inputs separately; they arrived. Re-run it after each Artifact rather than asking what changed. It also carries what this Stage declares — what it produces, its Gates, its exit conditions, its rework routes — so `xforge/flows/*.yaml` does not need opening: the Flow file is 400 lines and the Action already holds the outline you would go there for.
- Reread existing files and Action inputs before every edit; keep Requirements, Scenarios, decisions, and scope consistent across Artifacts.
- Let digest/revision changes invalidate stale Check, Apply, or Verify results. Never tamper with Evidence manually.

# Authority

- Modify only existing Proposal, delta Spec, Clarifications, or Design paths explicitly returned by State and within user-authorized scope.
- Do not write product code, Check reports, work-package delivery, Gate Evidence, verification receipts, canonical Specs, or Archive.

# Execution

1. Resolve the change reason, earliest affected Artifact, and downstream planning material requiring synchronization.
2. Make the minimum consistent revision to concrete existing paths while preserving machine headings and stable IDs.
3. Request a user decision before materially expanding Scope, compatibility impact, or permissions.
4. Refresh State and run `xforge check --change <id>`; confirm stale downstream Gate/Approval revisions and list Stages that must rerun. Change Stages only through CLI Transition.

# Evidence

- Report changed Artifacts/Requirements, reason, new State revision, invalidated scope, and next legal Action.

# Stop and rework

- Stop if a target path is missing, inputs conflict, authority does not cover the edit, or code/Evidence changes are needed; hand off to the owning Skill.
