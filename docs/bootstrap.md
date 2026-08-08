# XForge Bootstrap Guide

This guide is designed for an AI agent localizing a fixed XForge scaffold into
a user repository. Do not require the user to install a CLI before these
portable steps are complete.

## Required inputs

- A fixed XForge Git tag/full commit or a versioned HTTP artifact URL plus its
  SHA-256 digest.
- The absolute user-project root confirmed by the user or repository metadata.
- An allow-listed Git remote/HTTPS host when enterprise policy requires one.

Never use a floating branch for a formal installation. Never install a global
npm package, change `PATH`, or execute code from an undeclared source without
the user's approval.

## Procedure

1. Confirm the project root, inspect Git status, and preserve all existing
   files. Determine whether the existing documentation convention warrants
   `docs/specs` and `docs/changes`; otherwise retain the defaults.
2. Fetch only `scaffold/` outside the project:
   - Git: clone the fixed tag/commit using partial clone and sparse checkout for
     `scaffold/`.
   - HTTP: download the single-scaffold archive and verify the published
     archive SHA-256 before extracting it into a temporary directory.
3. Parse `scaffold/scaffold.yaml`. Require protocol `"1"`, resolve its declared
   `payload`, and verify every entry in `files.sha256` in stable relative-path
   order. Reject missing, extra, absolute, parent-traversing, or symlinked
   payload entries.
4. Produce a write plan from `payload/` to the project root. Stop on every
   existing destination, including identical content, unless the user gives
   explicit file-specific direction. Do not copy the temporary `.git`
   directory, XForge CLI source, cache, or repository history.
5. If requested, adjust only `project.paths.specs` and
   `project.paths.changes` in the planned `xforge/manifest.yaml`. Verify both
   remain relative, non-overlapping, inside the project, and outside generated
   tool directories.
6. Apply the approved plan, then remove the external temporary directory. The
   localized files are now normal project-owned Git assets.
7. Read `xforge/manifest.yaml`, `xforge/constitution.md`, and `xforge/lock.yaml`.
   Resolve the exact CLI declaration:
   - npm: exact package and version only;
   - Git: fixed repository, full 40-character commit, and `path: xforge`.
   Resolve and record the CLI distribution SHA-256 integrity in the Lockfile;
   Git builds must preserve source identity or inject the fixed build commit and
   repository into the build environment.
8. Check whether that exact CLI is already available. If it is absent or its
   version/commit/protocol does not match, stop Managed operations and tell the
   user the exact dependency required. Ask before installing it. The repository
   remains usable in Portable mode; never claim that gates or installation ran.
9. When the declared CLI is available and matches, run in this order:

   ```text
   xforge state
   xforge install --dry-run
   xforge install
   xforge check
   ```

   Inspect each JSON envelope. Do not continue after `ok: false`. Ask for user
   approval before high-risk hook, permission, network, or destructive writes.
10. Report the localized files, resolved logical paths, CLI identity, Adapter
    capability degradations, install changes, and check results. Recommend a
    Git review/commit; do not create one unless asked.

## Distribution equivalence

Release maintainers must build Git and HTTP distributions from the same
`scaffold/` tree. `files.sha256` is the canonical stable digest list for
`payload/`; the HTTP archive digest protects transport of `scaffold.yaml`, the
manifest, and the payload together.
