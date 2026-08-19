# XForge Agent Installation Runbook

This is the executable installation contract for a coding Agent. XForge is
installed only from the public npm package. Source checkouts, Git sparse
checkouts, locally packed tarballs, and separately downloaded Scaffold archives
are not supported installation inputs.

Supported baseline:

- package: `@xforge/cli@0.7.16`
- protocol: `2`
- Node.js: `>=20`
- distribution: npm only

Installation has three logical actions:

1. install the exact npm CLI package;
2. initialize the verified Scaffold bundled in that package;
3. project the Scaffold's selected Skills, agents, Rules, policies, Hooks, and
   other supported assets into one or more Agent tools.

Actions 2 and 3 may be combined with `xforge init --target <target>`.

## Instructions to the Agent

Complete installation and validation, not merely package installation. Preserve
all existing project work. Use the CLI's JSON output for decisions and report
every conflict, capability degradation, and platform trust step.

Do not commit, push, publish, deploy, enable remote services, or change global
machine configuration unless the user separately authorizes that action.

## Required inputs

Resolve before writing:

1. Exact target repository root.
2. Exact XForge npm version; this runbook requires `0.7.16`.
3. Project package manager and whether `@xforge/cli` is already declared.
4. Project layout, module paths, test/security commands, and Specs/Changes paths.
5. Agent-tool targets actually used: `codex`, `claude`, `cursor`, `opencode`,
   and/or `github-copilot`.
6. Existing `AGENTS.md`, `xforge/`, `.agents/`, `.codex/`, `.claude/`,
   `.cursor/`, `.opencode/`, `opencode.json`, and relevant `.github/` files.

## Safety rules

- Inspect `git status --short` and preserve unrelated dirty work.
- Install an exact npm version with `--save-exact`; do not use a floating tag,
  unpinned `npx`, Git checkout, HTTP Scaffold archive, or locally packed CLI.
- Do not copy files out of the XForge source repository. The npm package is the
  only CLI and Scaffold distribution.
- Never overwrite an existing project or Agent-tool file. `init`, `install`,
  `sync`, `update`, and `uninstall` must fail on unknown ownership or digest
  conflicts.
- Run `init`, `install`, `update`, and `uninstall` with `--dry-run` first.
- Keep credentials, personal data, npm configuration, private paths, and secret
  values out of project files and command transcripts intended for Git.
- Do not claim Managed enforcement until `state` reports
  `project.compatibility.mode: "managed"`.
- Do not enable blocking Hooks, runtime audit, remote audit, or external approval
  providers without reviewing platform trust and secret requirements.

## 1. Inspect the target project

From outside or inside the target repository, establish the exact root and
capture the current state:

```bash
git -C <target-root> rev-parse --show-toplevel
git -C <target-root> status --short
node --version
npm --version
```

Node.js must be 20 or newer. Do not execute placeholders literally.

Inventory collision-prone paths and determine whether the repository already
contains an initialized XForge project. If `xforge/manifest.yaml` exists, skip
initialization and use `xforge install --target <target>` for additional tools.

## 2. Install the exact npm CLI

Install XForge as an exact project development dependency:

```bash
cd <target-root>
npm install --save-dev --save-exact @xforge/cli@0.7.16
xforge version
```

Require a successful Protocol 2 JSON envelope with:

- name `@xforge/cli`;
- version `0.7.16`;
- protocol `2`;
- a `sha256:` runtime integrity value.

If the package cannot be resolved from the approved npm registry, stop. Do not
fall back to source, Git, HTTP, another scope, or a guessed version.

## 3. Initialize the project Scaffold

The npm package contains `scaffold/scaffold.yaml`, `files.sha256`, and the exact
payload paired with the CLI. `xforge init` verifies the inventory, hashes,
version, Protocol, paths, and symlink boundary before planning any project write.

For Scaffold initialization only:

```bash
xforge --root <target-root> init --dry-run
xforge --root <target-root> init
```

Review every planned file. A conflicting `AGENTS.md` or `xforge/` file is a hard
stop; do not replace it wholesale. Request an explicit semantic-merge decision
when the existing repository needs to retain equivalent content.

After initialization, review these project-owned files before projecting tools:

- `xforge/manifest.yaml`: project name, layout, modules, paths, selected
  resources, Flow, and targets;
- `xforge/scaffold/gates/*.yaml`: real test and security commands;
- `xforge/constitution.md`: principles supported by repository facts;
- approval and audit declarations: environment-variable names only, never
  secret values.

The Manifest must retain the npm identities installed by `init`:

```yaml
scaffold:
  version: 0.7.16
  source:
    type: npm
    package: "@xforge/cli"
    version: 0.7.16
xforge:
  source: npm
  package: "@xforge/cli"
  version: 0.7.16
  protocol: "2"
```

Git and HTTP source identities are invalid in Protocol 2 installation.

## 4. Project into Agent tools

To combine initialization and one target projection in a new project, use:

```bash
xforge --root <target-root> init --target <target> --dry-run
xforge --root <target-root> init --target <target>
```

This combined form preflights both Scaffold and Adapter destinations before the
first write. Use it only when the default Scaffold configuration is already
appropriate. When modules, Gates, policies, or selected resources need editing,
initialize first, review the canonical files, then install targets separately:

```bash
xforge --root <target-root> install --target <target> --dry-run
xforge --root <target-root> install --target <target>
```

Repeat for each selected target. Omitting `--target` projects every target
enabled in `xforge/manifest.yaml`:

```bash
xforge --root <target-root> install --dry-run
xforge --root <target-root> install
```

Inspect the capability matrix. Skills, agents, Rules, permission/MCP policies,
Hooks, commands, and sub-agent features are rendered only where an Adapter
supports them. `degraded` and `unsupported` are real boundaries, not successful
native installation.

## 5. Validate Managed mode

Run:

```bash
xforge --root <target-root> state
xforge --root <target-root> check
```

Require:

- envelope `ok: true`;
- `project.compatibility.mode: "managed"`;
- CLI and Protocol `matches: true`;
- no schema, path, secret, identity, Lockfile, ownership, or digest error;
- expected target files recorded in `xforge/.state.json`;
- no unexplained capability degradation.

Generated runtime Hooks use `xforge`, so they resolve the exact
project-local package and cannot download a missing replacement. Confirm the
selected Agent tool runs Hooks from the project root and explicitly trusts the
generated configuration where the platform requires review.

## Acceptance criteria

Report:

1. target root and preserved pre-existing dirty state;
2. exact npm package version and runtime integrity;
3. Scaffold version, verified file count, and any semantic merges requested;
4. Manifest modules, selected resources, Flow, Gates, and targets;
5. dry-run and applied changes for each target;
6. Adapter capability degradations and platform trust steps;
7. final Managed-mode and `check` results;
8. confirmation that no source/Git/HTTP installation path was used;
9. confirmation that no commit, push, deployment, or unrelated modification was
   performed.

Stop with a blocked report if any required acceptance condition is not met.
