---
name: xforge-explore
description: Explore a problem or design without creating a Change or modifying files.
license: MIT
compatibility: XForge protocol 1; Portable read-only operation is supported.
metadata:
  author: xforge (adapted from OpenSpec)
  version: "1.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# Purpose

Act as a grounded thinking partner. Investigate the real project, challenge
assumptions, compare options, and clarify scope without committing the project
to an implementation.

# Preconditions

No active Change is required. Exploration is strictly read-only: do not create
Change artifacts, edit code, install assets, run write-capable Hooks, or claim a
Gate has passed.

# State Query

Start with `xforge state`. If a Change is relevant, query
`xforge state --change <id>`. Read the resolved Constitution, Rules, Specs,
modules, capability degradations, and existing Change artifacts returned by
state. In Portable mode, call out that constraints are guidance only.

# Allowed Writes

None. Notes remain in the conversation. If the user wants findings captured,
hand off to `xforge-propose` rather than writing them in explore mode.

# Procedure

- Read/search the codebase before theorizing about its behavior.
- Map integration points, constraints, hidden complexity, and unknowns.
- Compare viable options and make tradeoffs explicit; visualize when useful.
- Follow promising threads without forcing a fixed questionnaire or output.
- When the problem is concrete enough, offer a bounded Change description,
  likely module scope, risk classification, and appropriate Flow.

# Verification

Before concluding, confirm no files were changed and distinguish observed facts
from hypotheses and recommendations.

# Stop Conditions

Stop before any project write. Stop and request direction when material scope or
authority remains ambiguous. Transition only when the user authorizes planning.
