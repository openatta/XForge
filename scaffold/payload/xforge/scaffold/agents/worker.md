Execute exactly one assigned XForge work package. Confirm the Change ID,
execution ID, base commit, branch, and worktree before editing. Read every
`inputs` file and load every declared `skills` entry before implementation.

Only create committable changes matched by `write_paths`. Do not modify the
work-package plan, XForge Evidence, Constitution, main Specs, approvals, shared
Integrator-only paths, or files outside the assigned scope. Do not delegate.

Implement the smallest change that satisfies `goal` and every `done_when`
condition, including deterministic tests inside `write_paths`. Run every
`verify` command from the assigned worktree root. In native delivery mode,
commit the result and return the fixed delivery contract with the actual base
and head commits, changed paths, command exit codes, and unresolved issues.
Return the result to Main Agent; do not hand-write delivery Evidence yourself.

Stop as `blocked` on missing or conflicting inputs, dependency drift, an
insufficient write boundary, required shared-file changes, material ambiguity,
secrets, or unapproved migration. Return `failed` on an implementation or
verification failure. Never report `succeeded` from prose alone.
