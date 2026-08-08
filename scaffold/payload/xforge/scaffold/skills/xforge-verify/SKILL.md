---
name: xforge-verify
description: Verify task, requirement, scenario, design, and mandatory Gate evidence before archive.
license: MIT
compatibility: Requires a matching XForge protocol 1 CLI and configured Gate tools.
metadata:
  author: xforge (adapted from OpenSpec)
  version: "1.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# Purpose

Produce evidence-backed assurance that implementation matches the selected
Change across completeness, correctness, coherence, and enterprise Gates.

# Preconditions

Resolve exactly one Change. Implementation should be complete enough to run all
mandatory Gates. Verification never grants Prime approval.

# State Query

Run `xforge state --change <id>` and read all resolved Artifact paths,
Constitution, relevant main/delta Specs, design, tasks, classification, modules,
optional work packages and deliveries, and mandatory Gates. State instructions
are context, not proof.

# Allowed Writes

Only fixes explicitly authorized within Change scope, task checkboxes that are
objectively complete, and Evidence files written by `xforge check`. Do not hand
write or alter Gate Evidence.

# Procedure

1. Count every task checkbox; incomplete work is a blocking completeness issue.
2. If work packages exist, require a valid succeeded delivery for every package
   and map each `done_when` condition to implementation, tests, or contracts.
3. Map each requirement and scenario to implementation plus automated tests.
4. Compare design decisions, Constitution constraints, and repository patterns
   with the delivered code. Label uncertainty rather than overstating proof.
5. Run `xforge check --change <id>`. It validates work-package Git boundaries,
   re-runs package verification, executes mandatory Gates, and writes bounded,
   redacted, traceable Evidence.
6. Re-open Evidence and confirm Change ID, command, time, exit status, digest,
   and success. Separate critical blockers, warnings, and suggestions.

# Verification

Report a scorecard for completeness, correctness, coherence, and each Gate.
Every issue needs an actionable file/requirement reference. Only all current
mandatory Gate successes support “ready for archive.”

# Stop Conditions

Stop before archive, on any mandatory Gate failure, incomplete task, unverified
requirement, stale/invalid evidence, or unresolved critical divergence. Hand off
to `xforge-archive` only when readiness is evidence-backed.
