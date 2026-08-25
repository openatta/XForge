# @xforge/cli

Git-native control plane for governed, AI-assisted software development.

XForge keeps specifications, workflow state, engineering rules, quality
evidence, approvals, and audit history as versioned project facts. It projects
project-owned Skills, agents, policies, and hooks to Codex, Claude Code,
Cursor, OpenCode, and GitHub Copilot without becoming another Agent runtime.

## Requirements

- Node.js 20 or newer
- npm 7 or newer

## Install

Install an exact version in the target project:

```bash
npm install --save-dev --save-exact @xforge/cli@0.7.20
xforge version --text
```

The npm package contains the CLI, protocol Schemas, and its exact verified
Scaffold. Initialize a project and project one Agent-tool target in a single
collision-safe operation:

```bash
xforge init --target codex --dry-run
xforge init --target codex
```

Use `--language en` or `--language zh-CN` to select the installed Skill and
sub-Agent instruction language. Without an explicit choice, `init` uses the
system locale; if detection fails it prompts on an interactive terminal and
otherwise exits with an actionable language-selection diagnostic. All other
Scaffold assets are English.

Alternatively, run `init` without a target, review and customize
`xforge/manifest.yaml`, then run `xforge install --target <target>` for each
tool. Source checkouts, local tarballs, Git/HTTP Scaffold distributions, and
source-built installation are not supported.

Follow the [Agent installation
runbook](https://github.com/openatta/XForge/blob/v0.7.20/AGENT_INSTALL.md) for the
full npm-only procedure. Generated runtime Hooks invoke `xforge
xforge` from the project root, resolving the exact local package without a
network fallback.

## Quick check

From an initialized XForge project:

```bash
xforge state --text
xforge install --target codex --dry-run --text
xforge check --text
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
- Read-only reporting: an in-flight Change portfolio via `xforge-status`, and
  `xforge-kanban` outside the Change lifecycle

Run `xforge help --text` for the complete command list. Project documentation
lives in the [XForge repository](https://github.com/openatta/XForge) and is
written in Simplified Chinese: start from the
[documentation index](https://github.com/openatta/XForge/blob/v0.7.20/docs/index.md),
or go straight to
[concepts and architecture](https://github.com/openatta/XForge/blob/v0.7.20/docs/concepts-and-architecture.md)
and the [governance model](https://github.com/openatta/XForge/blob/v0.7.20/docs/governance-model.md).

## Important boundary

XForge controls repository workflow state and evidence. It does not host model
processes, make unequal Agent platforms equivalent, or authorize application
deployment and production access.

## License

Apache-2.0. See the repository [LICENSE](https://github.com/openatta/XForge/blob/v0.7.20/LICENSE)
and [NOTICE](https://github.com/openatta/XForge/blob/v0.7.20/NOTICE).
