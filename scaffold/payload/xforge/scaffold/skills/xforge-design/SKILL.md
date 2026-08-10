---
name: xforge-design
description: Produce a governed technical design for a Solid or Major Change, including alternatives, failure boundaries, and verification; use for a ready Design Action after Proposal, Specs, and required Clarifications are satisfied.
license: MIT
metadata:
  author: xforge (adapted from the OpenSpec workflow)
  version: "3.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# Invariants

- Run `npx --no-install xforge state --change <id>`, consume only the current-revision ready Design Action, and reread every Action input.
- Design explains HOW, decisions, and boundaries. It does not repeat Proposal or become a file-by-file task list or persistent plan.
- Constitution, Rules, current architecture, and Specs constrain the design; summarize their implications instead of copying them mechanically.

# Authority

- Write only the Design Artifact path returned by the Action.
- Do not modify Proposal, Specs, Clarifications, product code, Check reports, Evidence, tasks, or Archive. Return upstream changes as rework.

# Execution

1. Model the current system, target behavior, integration points, data, and interface boundaries.
2. Record major decisions, viable alternatives and rejection reasons, failure modes, compatibility, migration, and rollback.
3. For Solid, define the implementation approach and verification notes needed for stable delivery.
4. For Major, also cover trust boundaries, risks and mitigations, test strategy, rollout, monitoring, stop signals, owner, and safe parallel boundaries.
5. Refresh State and run `npx --no-install xforge check --change <id>`; fix only Design-authorized structural issues. Stop for human Approval and invoke only a typed ready Transition after the receipt is satisfied.

# Evidence

- Map each major decision to a Requirement, project constraint, or code fact and state the verifiable result.
- Report coverage, residual risk, and the next legal Action against Action `doneWhen`.

# Stop and rework

- Stop on material ambiguity, Spec conflict, unknown trust boundary, irreversible impact, or an upstream change requirement.
- Hand upstream issues to Clarify/Revise and never silently expand Scope in Design.
