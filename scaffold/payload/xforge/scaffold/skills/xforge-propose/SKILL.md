---
name: xforge-propose
description: Create a governed Change and only the change.yaml, proposal, and delta Specs allowed by the Propose Stage; use when the user wants a sufficiently clear idea, defect, or feature formally specified but has not authorized implementation.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(npx:*)
---

# Invariants

- Run `npx --no-install xforge state` and read the Changes path, Flows, policy, Constitution, Rules, Specs, and modules from State.
- Consume only the ready Action for `xforge-propose`; reread Action inputs before every write and refresh State afterward.
- Quick is limited to low-risk, single-module, reversible changes with no critical impact; Solid serves ordinary product and engineering work; Major governs high-risk, cross-system, or critical-impact changes. Escalate or request a decision when uncertain.
- Every Flow answers the Constitution ledger, but not at the same point: Solid and Major answer it at Check, before implementation; Quick has no Check Stage and answers it at Verify, against the finished diff. Choosing Quick does not skip the Constitution, it only moves when the question is asked.
- Specs must use the machine-defined `ADDED|MODIFIED|REMOVED|RENAMED Requirements`, `Requirement`, `Scenario`, `WHEN`, and `THEN` headings.

# Authority

- Create one kebab-case Change ID under the State-resolved Changes directory and write `change.yaml` plus the Proposal/delta Spec paths returned by the Propose Action.
- Do not write Design, Clarifications, Check reports, persistent Tasks, product code, canonical Specs, Evidence, or Archive.
- Do not decide material compatibility, data, security, privacy, or scope questions for the user.

# Execution

1. Resolve one objective and check whether an active Change already covers it.
2. Set `flow` to the State-resolved manifest default unless the user explicitly requests a different Flow. Only deviate on your own initiative when classification (risk/security/privacy/publicApi/dataMigration) plainly conflicts with that default per Invariant 3 — then escalate or request a decision rather than silently overriding. Complete classification, modules, and a bounded project-relative path scope; note the Flow choice in the Proposal only when it was overridden or escalated, not when it simply inherited the default.
3. Create the minimum `change.yaml`, then run `npx --no-install xforge state --change <id>`. Preserve this unwrapped shape and replace values from project facts:

   ```yaml
   flow: solid
   classification:
     risk: medium
     security: false
     privacy: false
     publicApi: false
     dataMigration: false
   scope:
     modules: [root]
     paths: [src/**]
   ```

   Continue only with ready Propose Artifacts/Actions and clear all schema diagnostics first.
4. Reread dependencies from disk; write Why, Scope, Non-goals, Actors, Success criteria, and stable Requirement IDs with success, failure, boundary, and compatibility scenarios. Do not guess an unstated precise contract into a Spec fact; where an immutable acceptance test already fixes a field, output shape, or exit behavior, match it exactly, and stop as material ambiguity on any test/Requirement conflict.
5. Refresh State after each Artifact and stop when the next Action belongs to another Skill.
6. Run `npx --no-install xforge check --change <id>`, fix only Propose-stage structural issues, and do not call advisory text a passed Gate; run `npx --no-install xforge transition --change <id> --to <stage>` only when the CLI returns that Transition as ready.

# Evidence

- Report Change ID, Flow (default or overridden, with reason if overridden)/classification, actual paths, assumptions, and the next legal Action against the Action's `doneWhen` and `requiredEvidence`.
- Only current CLI output proves structure, policy, and path validation.

# Stop and rework

- Stop on unknown modules, path/identity/protocol diagnostics, material ambiguity, Flow-policy mismatch, or an authority boundary.
- Hand changed upstream facts to `xforge-revise`; do not implement opportunistically.

# Judgment calls

- The Flow default exists so the common case needs no risk-classification reasoning; overriding it is the unusual path, and doing so without noting it in the Proposal makes a deliberate call look like an oversight to the next reader.
- A Requirement that reads clearly to the author but only makes sense with unstated implementation knowledge is not testable by anyone else. Write scenarios a reviewer with no context on this Change could still verify against the running system.
