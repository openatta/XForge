# @xforge/cli

Git-native control plane for governed, AI-assisted software development.

XForge keeps specifications, workflow state, engineering rules, quality
evidence, approvals, and audit history as versioned project facts. It projects
project-owned Skills, agents, policies, and hooks to Codex, Claude Code,
Cursor, OpenCode, and GitHub Copilot without becoming another Agent runtime.

## Requirements

- Node.js 20 or newer
- An XForge project Scaffold using Protocol 2

## Install

Install an exact version in the project or in an external CLI cache:

```bash
npm install --save-dev --save-exact @xforge/cli@0.4.1
npx --no-install xforge version --text
```

Installing the npm package provides the CLI and protocol Schemas. A new project
must also localize the matching, integrity-checked XForge Scaffold. Follow the
[Agent installation runbook](https://github.com/openatta/XForge/blob/v0.4.1/AGENT_INSTALL.md)
for a collision-safe setup.

Generated runtime Hooks invoke the bare `xforge` command. Ensure the package's
`node_modules/.bin` directory is on the Agent tool's inherited `PATH` when
runtime policies or Hooks are enabled.

## Quick check

From an initialized XForge project:

```bash
npx --no-install xforge state --text
npx --no-install xforge install --dry-run --text
npx --no-install xforge check --text
```

JSON is the default output. `--text` changes presentation only; it does not
change command semantics or exit status.

## Main capabilities

- Quick, Solid, and Major spec-driven Flows
- Managed projections for five Agent tools
- Constitution, Rules, PermissionPolicies, Hooks, Gates, and Approvals
- Guarded Stage transitions and revision-bound Evidence
- Signed approval receipts and append-only Audit
- Governed work-package dispatch and delivery verification
- Conflict-safe install, sync, update, and uninstall
- Atomic delta-Spec Archive
- Protocol 1 Portable-read migration support

Run `xforge help --text` for the complete command list. Full documentation is
available in the [XForge repository](https://github.com/openatta/XForge),
including the [CLI guide](https://github.com/openatta/XForge/blob/v0.4.1/docs/cli-tool-usage.md)
and [governance design](https://github.com/openatta/XForge/blob/v0.4.1/docs/governance-control-plane-design.md).

## Important boundary

XForge controls repository workflow state and evidence. It does not host model
processes, make unequal Agent platforms equivalent, or authorize application
deployment and production access.

## License

Apache-2.0. See the repository [LICENSE](https://github.com/openatta/XForge/blob/v0.4.1/LICENSE)
and [NOTICE](https://github.com/openatta/XForge/blob/v0.4.1/NOTICE).
