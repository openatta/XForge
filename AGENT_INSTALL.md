# XForge Agent Installation Runbook

This file is an executable runbook for a coding Agent installing XForge into a
different source repository. The word **install** here means localizing the
XForge Scaffold and activating its CLI/Agent-tool projections. It does not mean
deploying the target application to production.

Current supported baseline:

- XForge CLI: `@xforge/cli 0.4.1`
- File protocol: `2`
- Node.js: `>=20`
- Available distributions: exact npm package or fixed XForge source checkout

## Instruction to the Agent

Complete the installation and validation, not merely the file copy. Preserve
the target repository's current work. Use machine-readable CLI output for every
decision and report all degradations and unresolved trust steps.

If any required input is unknown and cannot be discovered safely, stop before
writing and request that input. Do not substitute a floating branch, `latest`,
an arbitrary project root, or an inferred production policy.

## Required inputs

Resolve and record these values before writing:

1. The exact target repository root.
2. The XForge source repository and full 40-character commit, or—after npm
   publication—the exact `@xforge/cli` version plus a matching versioned
   Scaffold source.
3. The target project's layout, logical Specs/Changes paths, and modules.
4. Which Agent tools are actually used: `codex`, `claude`, `cursor`, `opencode`,
   and/or `github-copilot`.
5. Whether the project already has `AGENTS.md`, `xforge/`, or generated target
   files that would collide with the Scaffold or Adapter output.
6. How the bare `xforge` executable will be placed on the runtime `PATH` of the
   selected Agent tools.

## Non-negotiable safety rules

- Inspect `git status --short` in both source and target before changing files.
- A formal installation must use a clean XForge checkout at an immutable tag or
  full commit. A dirty source checkout is development-only and must be reported
  as non-reproducible.
- Keep downloaded source, build output used as a distribution, npm cache, and
  temporary Git metadata outside the target repository.
- Copy only `scaffold/payload/` into the target. Never copy the XForge source
  tree, its `.git`, `node_modules`, test fixtures, or caches into the target.
- Verify Scaffold integrity before copying. Reject missing, additional,
  absolute, parent-traversing, or symlinked payload entries.
- Never overwrite an existing destination. Stop on each collision and either
  preserve the file or perform an explicit, reviewed semantic merge. Existing
  `AGENTS.md` is a common collision and must not be replaced wholesale.
- Use exact package versions and exact Git commits. Do not use `latest`, a
  floating branch, or an unpinned `npx` download.
- Do not install globally or change a persistent machine-wide `PATH` without
  explicit user approval.
- Do not enable runtime audit, remote audit delivery, signed approval providers,
  or blocking Hooks without reviewing the target platform's trust and secret
  requirements with the user.
- Run every XForge write command with `--dry-run` first. Do not proceed when the
  envelope has `ok: false`, an error diagnostic, or an unexplained conflict.
- Do not claim Managed enforcement until `state` reports
  `project.compatibility.mode: "managed"`.
- Do not create a Git commit, push, publish a package, or deploy the application
  unless separately requested.

## Path A — install from source (available now)

### A1. Pin and verify the source

Obtain XForge outside the target repository and check out the requested full
commit. Verify:

```bash
git -C <xforge-source-root> rev-parse HEAD
git -C <xforge-source-root> status --short
node --version
```

Do not execute the placeholders literally. The resolved HEAD must equal the
requested commit and Node.js must be version 20 or newer. For a formal install,
the source status must be clean.

### A2. Verify and build XForge

From the XForge source root, run:

```bash
npm ci --prefix xforge
npm run verify
```

`verify` checks Scaffold integrity, builds the CLI, and runs the implementation
and product/security contract tests. It is required for a formal installation;
if environment policy prevents it, report the installation as unverified
rather than silently skipping it.

Check the CLI directly:

```bash
node <xforge-source-root>/xforge/dist/cli.js version
```

Require `ok: true`, name `@xforge/cli`, version `0.4.1`, protocol `2`, the
expected build commit/repository, and a `sha256:` runtime integrity value.

### A3. Build a local package and place it outside the project

The safest source workflow uses the package produced by the checked-out source
while retaining the npm identity expected by the default Scaffold.

Create two external directories: one temporary pack directory and one durable
CLI cache owned by the user. Create a minimal `package.json` in the CLI cache:

```json
{
  "name": "xforge-cli-cache",
  "private": true
}
```

Then run:

```bash
cd <xforge-source-root>
npm pack ./xforge --pack-destination <external-pack-directory>

cd <external-cli-cache>
npm install --save-exact <external-pack-directory>/xforge-cli-0.4.1.tgz
./node_modules/.bin/xforge version
```

Do not run `npm pack` against the source-repository root package; the package to
pack is the `xforge/` implementation directory and the result must identify as
`@xforge/cli@0.4.1`.

Use the absolute `<external-cli-cache>/node_modules/.bin/xforge` path for the
installation commands below. Also arrange for that directory to be on the
selected Agent tools' inherited `PATH`. Generated governance Hooks currently
invoke the bare command `xforge`; if `command -v xforge` fails in the Agent
runtime, Hook activation is incomplete even when direct CLI commands work.

If persistent PATH configuration or an exact global installation is the only
option, obtain explicit user approval before making that change.

## Path B — install from npm

The npm package supplies the CLI and Schemas; it does not bootstrap the project
Scaffold by itself. Resolve only the exact release from the approved registry.

Verify the exact version, create the same kind of external CLI cache described
above, and install without a floating tag:

```bash
npm view @xforge/cli@0.4.1 name version dist.integrity

cd <external-cli-cache>
npm install --save-exact @xforge/cli@0.4.1
./node_modules/.bin/xforge version
```

Obtain `scaffold/` separately from the same versioned XForge release: a fixed
Git commit or a published HTTP Scaffold artifact with its SHA-256. Never mix an
arbitrary Scaffold revision with an unrelated CLI release. If the exact package
cannot be resolved, stop or use Path A; do not guess a replacement version,
package, or scope. Continue with the common procedure below.

## Common procedure — localize and activate XForge

### 1. Inspect the target

Confirm the exact repository root through repository metadata, then inspect:

```bash
git -C <target-root> status --short
git -C <target-root> rev-parse --show-toplevel
```

Inventory at least:

- an existing `AGENTS.md` or `xforge/` directory;
- `.agents/`, `.codex/`, `.claude/`, `.cursor/`, `.opencode/`, `opencode.json`,
  and `.github/` paths relevant to selected targets;
- package manager and test/security commands;
- monorepo modules and existing Specs/Changes documentation locations.

Preserve all unrelated dirty work and record the pre-install status for the
final report.

### 2. Verify the Scaffold

For a source distribution, the required verification is:

```bash
cd <xforge-source-root>
npm run check:scaffold
```

The verifier checks `scaffold/scaffold.yaml`, `scaffold/files.sha256`, the exact
payload inventory, file digests, and symlink/path safety. For a released HTTP
artifact, verify the transport SHA-256 first, extract outside the target, then
run the equivalent manifest and payload verification.

Require Scaffold version `0.4.1` and Protocol `2` for this runbook.

### 3. Plan and copy only the payload

Build an explicit mapping from each regular file under
`<verified-scaffold>/payload/` to the same relative path below `<target-root>`.
Check every destination before copying.

If no destination collides, copy the payload contents—not the `payload`
directory itself—into the target root. If a destination exists:

- do not overwrite it, even when content appears identical;
- present the exact file and intended source;
- semantically merge only when the user has authorized that specific merge;
- revalidate YAML/Markdown structure after a merge.

The localized `xforge/` content becomes ordinary project-owned Git content.
The original distribution hash no longer describes it after project-specific
customization; reproducibility is subsequently recorded by `xforge/lock.yaml`.

### 4. Localize project configuration

Before the first managed install, review and update these canonical files.

In `xforge/manifest.yaml`:

- set `metadata.name`;
- set `project.layout`, `project.paths`, and every module ID/path/kind to match
  the repository without moving application source;
- keep only the Agent-tool `targets` that the project actually uses;
- select the intended Skills, agents, Rules, PermissionPolicies, Hooks, Gates,
  and Scripts;
- record the exact Scaffold repository/commit or HTTP artifact identity;
- for the local source-built package and the official npm package, keep the
  exact CLI declaration:

  ```yaml
  xforge:
    source: npm
    package: "@xforge/cli"
    version: 0.4.1
    protocol: "2"
  ```

- adapt `xforge/scaffold/gates/*.yaml` to the target's real test and security
  commands. The defaults use npm and are not correct for every repository;
- review approval providers and `audit.remote`. Store only environment-variable
  names in YAML, never secret values;
- keep `runtime-audit` disabled unless the user explicitly accepts its coverage,
  retention, redaction, PATH, and platform-trust implications.

In `xforge/constitution.md`, replace generic principles only with project facts
that the user or repository supports. Do not invent compliance obligations or
production policies.

### 5. Align the bootstrap Lockfile with the exact CLI

Run the selected executable in JSON mode:

```bash
<absolute-xforge-executable> version
```

Verify name, version, protocol, source identity, and runtime integrity. The
copied `xforge/lock.yaml` must describe the same CLI declaration and must set
`xforge.integrity` to the exact `data.integrity` returned by this command.
Also align the locked Scaffold identity and logical paths with the localized
Manifest.

This manual step only establishes the exact bootstrap identity. The first
successful `xforge install` will deterministically regenerate resource digests,
resolved paths, target selection, protocol, and CLI integrity in the Lockfile.

Never replace an integrity value merely to suppress an error unless the Agent
has verified the executable came from the pinned source/package selected in
this runbook.

### 6. Require Managed mode

From any directory, using the exact target root:

```bash
<absolute-xforge-executable> --root <target-root> state
```

Require all of the following before any managed write:

- envelope `ok` is `true`;
- `data.project.compatibility.mode` is `managed`;
- CLI and Protocol `matches` values are `true`;
- no error diagnostics report schema, secret, path, identity, or Lockfile
  problems.

If state is Portable, use its diagnostics to correct the declared executable,
Protocol, or bootstrap Lockfile. Do not continue with install and do not claim
that XForge protections are active.

### 7. Preview and apply Adapter projections

Run:

```bash
<absolute-xforge-executable> --root <target-root> install --dry-run
```

Inspect the JSON envelope, every `changes` entry, the per-target capability
matrix, and all diagnostics. In particular:

- every destination must be expected for an enabled target;
- no change may have action `conflict`;
- existing unowned Agent-tool files must not be overwritten;
- blocking Hook and permission-policy projections require user/platform trust;
- capability degradations must be included in the final report.

When the plan is accepted, run:

```bash
<absolute-xforge-executable> --root <target-root> install
<absolute-xforge-executable> --root <target-root> state
<absolute-xforge-executable> --root <target-root> check
```

Require `ok: true` after each command. The initial `check` validates project
structure and Lock freshness; Change-specific Machine Gates run later with
`xforge check --change <id>`.

### 8. Verify runtime command and trust activation

In the actual shell/environment inherited by each selected Agent tool, verify:

```bash
command -v xforge
xforge version
```

The result must be the same exact CLI identity and integrity used during
installation. Review the generated platform files and identify any trust or
reload action the user must complete. File presence alone does not prove that a
platform loaded a Skill, trusted a project Hook, or enforces every policy.

If a runtime cannot resolve `xforge`, either complete the approved PATH setup or
report Hooks as inactive. Do not describe the installation as fully activated.

### 9. Final inspection and report

Inspect the target's final `git status --short` and diff. Do not commit. Report:

1. source mode, exact XForge commit/package, CLI version, Protocol, and runtime
   integrity;
2. Scaffold source/version and integrity verification result;
3. localized project paths, modules, selected resources, and targets;
4. every created, modified, merged, skipped, and conflicting file;
5. Managed/Portable mode and the results of `install --dry-run`, `install`,
   `state`, and `check`;
6. Adapter capability degradations and runtime audit status;
7. whether the bare `xforge` command resolves in every Agent runtime;
8. outstanding platform trust/reload actions, approval/audit secret setup, or
   other manual work;
9. the final Git diff summary and confirmation that no commit or application
   deployment was performed.

## Acceptance criteria

Installation is complete only when:

- the verified Scaffold payload has been localized without unreviewed
  overwrites;
- project configuration describes the actual repository;
- `xforge state` reports Managed mode with matching CLI and Protocol;
- `xforge install --dry-run`, `xforge install`, and `xforge check` all return
  `ok: true` without unresolved conflicts;
- generated output is owned in `xforge/.state.json` and the resolved identities
  are recorded in `xforge/lock.yaml`;
- the same bare `xforge` executable is resolvable by selected Agent runtimes, or
  any resulting Hook limitation is explicitly reported;
- the user receives a reviewable diff and a list of manual trust steps.

## Suggested user prompt

```text
Install XForge into this repository by following AGENT_INSTALL.md exactly.
Use source mode from <absolute-XForge-source-path> at <full-40-character-commit>.
Localize only the verified Scaffold payload. Preserve all existing work, do not
overwrite files, do not install globally, do not commit, and do not deploy the
application. Configure only the Agent targets actually present in this project.
Stop and report any collision or policy decision that requires my approval.
Finish only after Managed mode, install dry-run, install, check, runtime PATH,
and the final Git diff have been verified.
```
