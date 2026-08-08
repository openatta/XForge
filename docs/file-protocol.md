# XForge file protocol 1

Protocol 1 uses UTF-8 YAML/Markdown project assets and a stable JSON command
envelope. Static JSON Schemas are shipped in `xforge/schemas/`.

## Project discovery and paths

The CLI walks upward from the working directory until it finds
`xforge/manifest.yaml`. All declared paths are project-relative. Absolute
paths, `..`, NUL bytes, generated-target roots, overlapping Specs/Changes
paths, and symlink escapes are rejected before a write plan is applied.

Defaults are `xforge/specs` and `xforge/changes`. Flow and Change artifact
paths are always resolved relative to the selected Change. Resource IDs are
lowercase kebab-case and therefore cannot encode paths.

## CLI identity

An npm declaration requires an exact semantic version and package name. A Git
declaration requires a full 40-character commit and `path: xforge`. The running
CLI is identified by package version, protocol, and—when Git sourced—the
build-time `XFORGE_BUILD_COMMIT`. Mismatch is read-only Portable state; every
write command fails before planning project mutations.

Git cache builders should preserve the source `.git` metadata or set both
`XFORGE_BUILD_COMMIT` and `XFORGE_BUILD_REPOSITORY`. The Lockfile records a
`sha256:` digest of the executable distribution (`dist`, Schemas, package
metadata, and packaged license); Managed mode verifies it before writes.

## Command envelope

Each command emits exactly one JSON value by default:

```json
{
  "protocolVersion": "1",
  "ok": true,
  "command": "state",
  "root": "/absolute/project",
  "data": {},
  "diagnostics": [],
  "changes": [],
  "nextActions": []
}
```

Diagnostics have stable codes. Exit status is `0` for `ok: true` and `1` for
`ok: false`. `--text` presents the same envelope fields for people without
changing execution or status semantics.

## Ownership and evidence

`xforge/.state.json` records every generated file's source resource, target,
CLI/protocol versions, and last installed SHA-256. An unmanaged destination or
a changed managed destination is a conflict. Pruning only removes a file whose
current digest still matches its recorded generated digest.

Gate evidence records the Change, command array, UTC timestamps, duration,
exit status, bounded/redacted output, and content digest. Guidance alone is not
gate proof; only successful evidence created by a completed runner is a pass.

## Work packages and delivery evidence

An active Change may contain `work-packages.yaml` with
`apiVersion: xforge.dev/v1alpha1`, `kind: WorkPackagePlan`, and a non-empty
`packages` array. Each package has exactly `id`, `goal`, `depends_on`, `inputs`,
`write_paths`, `skills`, `verify`, and `done_when`. Inputs are existing exact
project-relative files. Write paths use project-relative literal paths, `*`, or
`**`; root-wide patterns, scope escapes, protected shared paths, and potentially
overlapping dependency-independent packages are rejected.

Main Agent records returned Worker delivery at
`<change>/evidence/agents/<package-id>/<execution-id>.yaml`. State validates the
record against Git commits and computes package readiness. Check requires every
package to have a valid succeeded delivery, compares the declared paths with
the actual base-to-head diff, and reruns every `verify` command into XForge Gate
Evidence. Worktree creation and Agent process scheduling remain target-runtime
responsibilities rather than file-protocol commands.

## Archive merge contract

New capability specs copy into the resolved Specs path. Existing specs accept
OpenSpec-style delta sections (`ADDED`, `MODIFIED`, `REMOVED`, `RENAMED
Requirements`) and are merged by requirement name. A non-delta document never
silently replaces an existing main spec. Archive stages all spec writes and the
Change move as a recoverable filesystem transaction.
