English | [简体中文](docs/README.md)

# XForge

XForge is a Git-native control plane for governed, AI-assisted software
development. It turns specifications, workflow state, engineering rules,
quality evidence, approvals, and audit history into versioned project facts,
then projects the right Skills, agents, policies, and hooks into the AI coding
tools a team already uses.

XForge is not another Agent runtime. Models and coding tools still explore,
design, and implement the change; XForge defines what is true, which transition
is legal, and what evidence is required before the change can advance or close.

> **Current release:** `@xforge/cli 0.7.5`, Protocol 2, Node.js 20 or newer.
> Install the exact CLI version from npm. Source-based installation is not
> supported. The implementation remains under active development.

## Design goals

- **Keep project truth in Git.** The Constitution, Specs, Changes, Flows,
  Rules, policies, and localized Agent assets live with the code and remain
  readable without a service account or hosted control plane.
- **Stay portable across Agent tools.** One canonical project model can be
  projected to Codex, Claude Code, Cursor, OpenCode, and GitHub Copilot while
  reporting capability gaps instead of pretending the platforms are equal.
- **Separate guidance, permission, and proof.** A Rule can instruct an Agent, a
  PermissionPolicy can guard an action, and a Gate can prove a result. XForge
  never treats one of those as another.
- **Make governance proportional to risk.** Small reversible work can take the
  Quick path; routine product work uses Solid; high-risk or cross-system work
  uses Major with stronger review, approval, and audit boundaries.
- **Fail closed at managed boundaries.** Writes require an exact CLI/protocol
  identity. Generated-file conflicts, stale receipts, failed Gates, incomplete
  audit history, and unsafe paths stop the operation rather than being silently
  ignored.
- **Remain a control plane, not an execution monopoly.** XForge coordinates
  state, evidence, and policy, but it does not host models, replace coding
  tools, or grant production deployment authority.

## How it fits together

```text
Canonical, project-owned sources
  AGENTS.md + xforge/{manifest,constitution,specs,changes,flows,scaffold}
                              |
                              v
                    @xforge/cli (Protocol 2)
                    /                       \
     deterministic workflow state       Adapter projections
     Gates / approvals / receipts        Skills / agents / policies / hooks
     audit / atomic archive              for supported coding tools
```

Files under `xforge/` are the source of truth. Directories such as `.agents/`,
`.codex/`, `.claude/`, `.cursor/`, `.opencode/`, and selected `.github/` files
are generated projections; edit the canonical assets and run `xforge sync` or
`xforge update` instead of hand-editing generated output.

## Main features

### Risk-scaled, spec-driven Flows

| Flow | Intended use | Persisted lifecycle |
| --- | --- | --- |
| `quick` | Low-risk, bounded, reversible changes | Propose → Apply → Verify → Archive |
| `solid` | Routine product and engineering changes | Propose → Design → Apply → Verify → Archive |
| `major` | High-risk, critical-impact, or cross-system changes | Propose → Clarify → Design → Check → Apply → Verify → Archive |

Flow policy validates whether a Change classification is eligible. Stages are
advanced by guarded CLI transitions, not by an Agent editing a status field or
claiming that work is complete.

### A truthful governance model

- **Constitution** holds long-lived, non-negotiable engineering principles.
- **Rules** provide scoped model guidance and declare their Gate, policy, or
  approval coverage.
- **PermissionPolicies** express `allow`, `ask`, and `deny` decisions for files,
  shell, network, MCP, sub-agents, and external writes.
- **Hooks** bridge supported runtime events or add workflow automation without
  masquerading as quality evidence.
- **Gates** execute deterministic checks and write revision-bound Evidence.
- **Approvals** record interactive human decisions or verify signed external
  receipts; Agents cannot self-approve.
- **Transitions and Archive** require current Artifacts, Evidence, approvals,
  and audit completeness. Archive merges delta Specs and closes the Change
  atomically.

### Safe, reproducible Agent-tool projection

The npm package contains the exact verified project Scaffold paired with the
CLI. `init`, `install`, `sync`, `update`, and `uninstall` maintain per-target
ownership and content digests. Dry runs show the complete plan. Unknown files,
user edits, symlinks, path traversal, and ownership conflicts are rejected.
XForge only removes files that it owns and whose digest still matches.

Supported projection targets are:

- Codex
- Claude Code
- Cursor
- OpenCode
- GitHub Copilot

Guidance, permissions, runtime hooks, cloud coverage, and managed-policy
support differ by target. See the [Adapter capability matrix](docs/adapter-matrix.md)
for the implemented mappings and degradations.

### Machine-readable state and evidence

The CLI emits one Protocol 2 JSON envelope by default, including diagnostics,
planned file changes, and typed next actions. Add `--text` for a human-readable
view without changing semantics or exit status.

Change state is revision-aware. Gate Evidence, transition receipts, approval
receipts, work-package dispatches, deliveries, and the append-only audit chain
are checked against the current content, state, policy snapshot, and Git HEAD.

### Governed parallel work

Apply can describe dependency-aware work packages with non-overlapping write
paths. XForge issues revision-bound dispatch receipts and validates delivery
evidence, while the selected Agent runtime performs the actual delegation. If
a platform lacks native sub-agent support, execution remains sequential and
the degradation is reported.

### Read-only Skills outside the Change lifecycle

Not every Skill touches Change/Flow/Gate state. `xforge-explore` investigates
code, Specs, Rules, and options without writing, narrowing an ambiguous idea
into a proposal-ready scope. `xforge-kanban` turns plain `git log` into a
Markdown activity dashboard: per-contributor commits, lines, and active days,
a weekday x hour heatmap, a feat/fix/other breakdown, and a per-module split
for multi-module projects. Both are read-only and safe to run at any time.

### Portable and Managed operation

- **Portable mode** keeps the repository understandable when the declared CLI
  is unavailable; project files remain usable as guidance, but XForge does not
  claim that deterministic enforcement ran.
- **Managed mode** requires the declared CLI identity, Protocol, and Lockfile
  integrity to match. Only this mode may install projections, run Gates, record
  governed transitions, approve, dispatch work packages, perform managed audit
  writes/delivery, or archive.

## Getting started

XForge commands are meant to be issued by an AI coding Agent, not typed ad hoc
by a human. A human or CI performs the one-time pinned install below; every
later operation — initialization, Flow execution, Transitions — is an Agent
invoking `npx --no-install xforge ...` exactly as the installed `xforge-*`
Skills document. Never simplify that to a bare `xforge` (a project-local
install does not put the binary on an Agent's shell `PATH`) and never drop
`--no-install` (it makes the invocation fail loudly on a missing pinned CLI
instead of letting `npx` silently fetch a different, unpinned version).

Install the exact npm package in the target project, then let that CLI verify
and initialize its bundled Scaffold:

```bash
npm install --save-dev --save-exact @xforge/cli@0.7.5
npx --no-install xforge init --dry-run
npx --no-install xforge init
```

On first initialization, `--language en|zh-CN` overrides locale detection. If
no language can be detected, an interactive terminal asks the user to choose;
non-interactive initialization fails with an actionable `--language` command.
Skills, sub-Agent instructions, and the Constitution are localized. English is
the default, Chinese source variants use the `_cn` suffix, and all other
Scaffold assets remain English.

Project the canonical Skills, agents, Rules, permission/MCP policies, Hooks, and
other supported assets into one Agent tool:

```bash
npx --no-install xforge install --target codex --dry-run
npx --no-install xforge install --target codex
```

For a new project whose default Scaffold needs no customization, combine both
steps:

```bash
npx --no-install xforge init --target codex --dry-run
npx --no-install xforge init --target codex
```

Omit `--target` from `install` to project every target enabled in the Manifest.
Source checkouts, locally packed tarballs, Git sparse checkouts, and separate
HTTP Scaffold archives are not supported installation inputs.

For a coding Agent, provide the root-level [Agent installation
runbook](AGENT_INSTALL.md):

```text
Install XForge into this repository by following AGENT_INSTALL.md exactly.
Do not overwrite existing files or commit changes. Stop and report conflicts.
```

The runbook requires the Agent to use the exact npm package, verify the bundled
Scaffold, adapt modules/targets/Gates, preserve existing files, review every dry
run, and confirm Managed mode and platform trust.

After installation, verify the project from its root:

```bash
npx --no-install xforge version --text
npx --no-install xforge state --text
npx --no-install xforge check --text
```

Use the default JSON output instead of `--text` when another program or Agent
needs to consume the result.

## Using XForge for a change

The installed `xforge-*` Skills are the normal user interface. A typical first
request is:

```text
Use the xforge-propose Skill to create a Change for <goal>.
Choose the weakest Flow that is safe and explain the classification.
```

From there, `xforge-status` explains current state, `xforge-continue` performs
the next legal action, and the lifecycle Skills handle the active stage:
`xforge-clarify`, `xforge-design`, `xforge-check`, `xforge-apply`, and
`xforge-verify`. `xforge-revise` updates planning artifacts while preserving
their consistency, and `xforge-scaffold` customizes the project-owned Agent
assets. `xforge-kanban` sits outside this lifecycle entirely and reports
Git-history activity on request, without reading or requiring any Change.

The underlying CLI loop is:

```bash
npx --no-install xforge state --change <change-id>
npx --no-install xforge check --change <change-id>
npx --no-install xforge transition --change <change-id> --to <next-stage> --dry-run
npx --no-install xforge transition --change <change-id> --to <next-stage>

# When state reports a ready work package:
npx --no-install xforge work-package dispatch --change <change-id> --package <package-id>

# When state reports a required approval:
npx --no-install xforge approve --change <change-id> --for <stage-or-archive> ...

npx --no-install xforge audit verify --change <change-id>
npx --no-install xforge archive --change <change-id> --dry-run
npx --no-install xforge archive --change <change-id>
```

Do not copy this sequence blindly: `state.nextActions` is authoritative, and a
Flow may require rework, extra Gates, external approval receipts, or remote
audit delivery before the next transition.

## Maintaining an installation

After editing canonical resources under `xforge/scaffold/` or changing the
selected resources in `xforge/manifest.yaml`, use:

```bash
npx --no-install xforge sync --dry-run
npx --no-install xforge sync --verify-digests
```

Use `xforge update --dry-run` followed by `xforge update` when targets,
Scaffold/CLI identity, or Adapter output changes. Use `xforge uninstall
--target <target> --dry-run` to preview safe removal of one target's managed
files.

## Important boundaries

- Runtime Hook and permission coverage is platform-specific and may require an
  explicit project trust step in the coding tool.
- The default `runtime-audit` Hook is selected but disabled until a project
  deliberately enables it.
- Generated Hooks invoke `npx --no-install xforge` from the project root so they
  resolve the exact local package without downloading a replacement.
- Gate success proves the configured command ran for the recorded revision; it
  does not prove every semantic requirement is correct.
- Local approval attestation is repository-level evidence, not enterprise
  identity. Higher-assurance flows should use signed external receipts.
- `archive` closes an XForge Change. It does not deploy an application, publish
  a release, run a migration, or grant access to production systems.

## Repository layout

```text
XForge/
├── scaffold/              # Versioned canonical Scaffold distribution
├── xforge/                # @xforge/cli source, schemas, build, and tests
├── docs/                  # Product, protocol, governance, and design docs
├── tests/                 # Product/security and live-engine validation
├── AGENT_INSTALL.md       # Agent-executable installation runbook
└── README.md              # English overview
```

## Documentation

- [Agent installation runbook](AGENT_INSTALL.md)
- [CLI usage](docs/cli-tool-usage.md)
- [Flows and Skills](docs/flows-and-skills-design.md)
- [Skills, Flows, Rules, Gates, Hooks, PermissionPolicies, and Approvals](docs/governance-concepts.md)
- [Extending Skills and Flows](docs/extending-skills-and-flows.md)
- [Extending Gates, Rules, PermissionPolicies, Hooks, and Approvals](docs/extending-gates-rules-policies-hooks-approvals.md)
- [Extending Approvals with an MCP provider](docs/extending-approvals-with-mcp.md)
- [Governance control plane](docs/governance-control-plane-design.md)
- [File protocol](docs/file-protocol.md)
- [Sub-agent design](docs/sub-agent-system-design.md)
- [Product specification](docs/XFORGE_PRODUCT_SPEC.md)

## Developing XForge

```bash
npm ci --prefix xforge
npm run verify
```

Useful narrower checks are `npm run build`, `npm test`, `npm run
check:scaffold`, and `npm run test:product`.

Release maintainers should follow the privacy-safe [release runbook](RELEASING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
