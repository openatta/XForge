---
name: xforge-propose
description: Create a governed Change and only the change.yaml, proposal, and delta Specs allowed by the Propose Stage; use when the user wants a sufficiently clear idea, defect, or feature formally specified but has not authorized implementation.
license: MIT
metadata:
  author: xforge (adapted from the OpenSpec workflow)
  version: "3.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# Invariants

- Run `npx --no-install xforge state` and read the Changes path, Flows, policy, Constitution, Rules, Specs, and modules from State.
- Consume only the ready Action for `xforge-propose`; reread Action inputs before every write and refresh State afterward.
- Quick is limited to low-risk, single-module, reversible changes with no critical impact; Solid serves ordinary product and engineering work; Major governs high-risk, cross-system, or critical-impact changes. Escalate or request a decision when uncertain.
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
4. Reread dependencies from disk; write Why, Scope, Non-goals, Actors, Success criteria, and stable Requirement IDs with success, failure, boundary, and compatibility scenarios. Preserve exact contracts already fixed by immutable acceptance tests; stop on a test/requirement conflict.
5. Refresh State after each Artifact and stop when the next Action belongs to another Skill.
6. Run `npx --no-install xforge check --change <id>`, fix only Propose-stage structural issues, and invoke a transition only when the CLI returns a ready Transition.

# Evidence

- Report Change ID, Flow (default or overridden, with reason if overridden)/classification, actual paths, assumptions, and the next legal Action against the Action's `doneWhen` and `requiredEvidence`.
- Only current CLI output proves structure, policy, and path validation.

# Stop and rework

- Stop on unknown modules, path/identity/protocol diagnostics, material ambiguity, Flow-policy mismatch, or an authority boundary.
- Hand changed upstream facts to `xforge-revise`; do not implement opportunistically.
