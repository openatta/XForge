---
name: xforge-propose
description: Create a governed Change and generate every planning artifact allowed by its Flow.
license: MIT
compatibility: Requires a matching XForge protocol 1 CLI for dynamic Flow state.
metadata:
  author: xforge (adapted from OpenSpec)
  version: "1.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# Purpose

Turn a sufficiently clear request into project-owned planning artifacts. This
Skill plans; it does not implement code in the same invocation.

# Preconditions

Understand observable scope and material compatibility decisions. Derive a
lowercase kebab-case Change ID. Planning requires Managed mode because Artifact
instructions and dependencies must come from the resolved Flow.

# State Query

Run `xforge state`, read the resolved paths, Constitution, modules, Flows,
Rules, Specs, and diagnostics. Select `quick` only for low-risk single-module
work; use `prime` for high risk or any security, privacy, public API, or data
migration impact; otherwise use `solid`. When unsure, choose the stricter Flow.

# Allowed Writes

Only `<changes>/<id>/change.yaml` and planning Artifacts returned by repeated
`xforge state --change <id>` queries. Never edit product source or main Specs.

# Procedure

1. Create `change.yaml` with explicit Flow, full classification flags, module
   IDs, and bounded repository-relative path scopes. Explain the Flow choice in
   `proposal.md`.
2. Query `xforge state --change <id>`. Take the first `nextArtifact`; never
   assume a hard-coded proposal/design/tasks sequence.
3. For that Artifact, re-read completed dependencies and use the returned
   instruction and outline. Apply Constitution and matching Rules as constraints
   without copying their text into the Artifact.
4. Write only to the returned Artifact pattern. For a glob, choose a concrete,
   capability-oriented path and keep existing Specs organization.
5. Re-query state after each Artifact. Continue in Flow order until all planning
   Artifacts reachable without implementation or external approval are done.
6. Prime approval remains pending. An Agent may prepare the request but must not
   mark itself or another Agent as an authorized approver.

# Verification

Run `xforge check --change <id>` and resolve structural diagnostics. Present the
Change path, Flow, classification, artifacts, assumptions, and next action. Do
not describe a Gate as passed unless current CLI evidence says so.

# Stop Conditions

Stop before implementation. Stop on path/identity/protocol diagnostics, unknown
module scope, critical ambiguity, or an approval boundary.
