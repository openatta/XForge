---
name: xforge-archive
description: Preview, gate, synchronize Specs, and atomically archive one completed Change.
license: MIT
compatibility: Requires a matching XForge protocol 1 CLI.
metadata:
  author: xforge (adapted from OpenSpec)
  version: "1.0"
  source: OpenSpec e50bd0983dc8dc48250e3181f36e28450542f2ab
---

# Purpose

Close a completed Change without a separate sync command: preview all writes,
enforce mandatory Gates, merge delta Specs, and move the Change to its dated
archive location.

# Preconditions

Resolve one active Change. Required Artifacts and tasks must be complete and any
Prime approval must be externally granted. The running CLI must be Managed and
identity-compatible.

# State Query

Run `xforge state --change <id>` and read resolved logical paths, archive
requirements, Specs, Constitution, Rules, classification, and Gate list. Never
hard-code `xforge/specs` or `xforge/changes`.

# Allowed Writes

Only writes planned by `xforge archive --change <id>`: Gate Evidence, resolved
main Specs, and the dated Change move. Do not manually copy delta Specs or move
the directory.

# Procedure

1. Run `xforge archive --change <id> --dry-run`. Confirm `ok: true`, zero
   filesystem writes, the complete write/move plan, merge behavior, and target.
2. Review conflicts and all mandatory Gate requirements. Present any destructive
   or compatibility-significant effect before execution.
3. Run `xforge archive --change <id>`. The CLI rechecks structure, executes
   mandatory Gates, records Evidence, stages Spec merges, and performs the
   recoverable archive transaction.
4. Inspect the JSON envelope and changed paths. Run `xforge state` to confirm the
   Change left the active set and the main Specs are visible.

# Verification

Report the archive location, synced capability Specs and digests, Evidence paths,
and any Adapter/quality diagnostics. A moved directory without successful Gates
and verified Spec writes is not a completed archive.

# Stop Conditions

Stop on dry-run diagnostics, target collision, incomplete Artifacts/tasks,
approval ambiguity, failed Gate, merge conflict, path safety failure, or any
unplanned write. Never bypass a mandatory Gate or create a standalone sync step.
