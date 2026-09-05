---
description: "interfaces-are-contract-governed (must)"
applyTo: "src/**,migrations/**"
---

# interfaces-are-contract-governed

Severity: must

Scope: src/**, migrations/** — this Rule reaches a Change whose declared scope.paths share a root with these, and your host also treats them as file globs.

Interfaces between modules — HTTP operations, event schemas, database table structure, and the symbols one module exports to another — are defined by the baseline under xforge/contracts/, and a Change that alters one declares the alteration in its own contract-delta before implementing it. Reference the contract from the implementation rather than restating it, so there is one place a reader can be wrong about. Never edit the baseline directly: it is the record of what was agreed, archive merges the delta into it, and a Worker who edits it in place leaves every other package building against something nothing agreed to. When the implementation and the contract disagree, change the implementation — changing the contract is a decision that needs a named person in evidence/conditions/contractDecisions.yaml. The protected-files policy is a guardrail an honest Agent respects rather than a boundary that stops a determined one; the binding check is contract-compat, which compares what the delta declared against what actually moved.

Enforcement: gates=none; policies=protected-files; approvals=none.
