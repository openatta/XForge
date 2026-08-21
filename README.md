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

> **Current release:** `@xforge/cli 0.7.17`, Protocol 2, Node.js 20 or newer.
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

XForge is two things that meet in your repository: a **CLI** that decides what
is true and legal, and a **Scaffold** that tells an Agent how to work. Knowing
which is which explains almost every rule below.

```text
  @xforge/cli (npm, pinned exactly)
  └── carries a verified Scaffold payload
                    │
                    │  xforge init          ── once per project
                    ▼
  xforge/                                      ← canonical, project-owned, in Git
  ├── manifest.yaml · constitution.md · XFORGE.md
  ├── specs/ · changes/ · flows/
  └── scaffold/  skills · agents · rules · policies · hooks · gates
                    │
                    │  xforge install / sync / update
                    ▼
  .claude/ · .agents/ · .codex/ · .cursor/ · .opencode/ · .github/
                                               ← generated projections, not sources

  The Agent reads the projections.     The CLI reads xforge/ and answers with
  It follows Skills.                   state, Gates, receipts, approvals, audit.
```

**The Scaffold is what an Agent reads; the CLI is what tells the truth.** A
Skill can instruct, a PermissionPolicy can guard, a Gate can prove — XForge
never lets one stand in for another, and only the CLI's JSON output and Gate
evidence count as facts.

Three consequences follow, and they explain most of what surprises newcomers:

- **Projection is one-way and recomputable.** `xforge/scaffold/**` is the
  source; the tool directories are output. Edit the source and run
  `xforge sync`. Hand-editing generated output is refused rather than merged,
  because the next projection would silently overwrite it.
- **The npm package is the only supported input.** The Scaffold ships inside
  the pinned CLI and is verified against a checksum manifest before it is
  written. Source checkouts, local tarballs, and separate archives are not
  installation inputs, so a project can always say exactly which bytes it runs.
- **Your customizations survive upgrades.** `xforge/scaffold/**` is yours to
  edit once initialized; the CLI reconciles rather than replaces, and refuses
  when it cannot tell your change from its own.

Files XForge co-owns with you — `AGENTS.md`, `CLAUDE.md` — are merged through a
marker block. Everything outside `<!-- XFORGE:BEGIN -->` … `<!-- XFORGE:END -->`
is preserved byte for byte, and re-running installation replaces the block in
place instead of appending a second one.

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

### Verification a project declares, in any language

The shipped `unit-tests` and `security-scan` Gates once ran npm. On a project
without a `package.json` they reported `passed` having asserted nothing, so a
`must` Rule lost its only enforcement and an archive's mandatory Gate was empty.

Gates now run the command the project declared under `manifest.verification`
and **refuse** when nothing is declared. A refusal is an unanswered question,
not a failing check. `xforge verification declare` writes the entry so no Agent
has to hand-edit the Manifest, and toolchain detection across fifteen ecosystems
proposes a command — a proposal being the start of a question to a person, never
an answer.

### One place to write the architecture down

Requirements survive a Change because `syncSpecs` merges them back. Architecture
had no such path, so each Change's decisions archived with it and the next one
re-derived them from code. `xforge/architecture.md` is that durable record, and
`xforge-architect` is its only writer — from existing code, by questioning, or
from a description. It is capped at fifty lines and six decisions, because a
decision earns its place by being one whose reversal would touch several
modules. Nothing requires the file; `doctor` suggests it and never fails on it.

### Read-only Skills outside the Change lifecycle

Not every Skill touches Change/Flow/Gate state. `xforge-kanban` turns plain
`git log` into a Markdown activity dashboard: per-contributor commits, lines,
and active days, a weekday x hour heatmap, a feat/fix/other breakdown, and a
per-module split for multi-module projects. `xforge-status` reports where a
Change stands, `xforge-architect` writes the architecture file, and
`xforge-upgrade-scaffold` merges a newer Scaffold. All are read-only with
respect to Change state and safe to run at any time.

Investigating code, Specs, and options before proposing needs no Skill of its
own — reading and search are native to every coding tool XForge projects into.
Narrowing an ambiguous idea into a proposal-ready scope is the first step of
`xforge-propose`.

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
by a human. A human or CI installs the CLI once; every later operation —
initialization, Flow execution, Transitions — is an Agent invoking
`xforge ...` exactly as the installed `xforge-*` Skills document.

**npm is only how the tool is distributed.** XForge is a command, not a
dependency of your project: it never becomes part of your build, and installing
it does not make a Python, Go, or Rust repository into a Node one. Install it
globally and your project keeps no `package.json` and no `node_modules`.

Three ways to install it, in the order most people should try them:

| | When to use it | What it leaves in your project |
| --- | --- | --- |
| [Agent](#1-let-an-agent-do-it) | The normal path — you are already in a coding tool | `xforge/`, `AGENTS.md`, one tool directory |
| [Manual](#2-manual) | You want to run the commands yourself | the same |
| [Project-local](#3-project-local-when-one-global-version-is-not-enough) | Several projects pinned to different XForge versions, or an isolated CI runner | the same, plus `package.json` and `node_modules` |

### 1. Let an Agent do it

Open your project in an AI coding tool and paste this into the session. It
installs the CLI, initializes the project, and projects the Scaffold — and it
asks you the two questions no tool can answer for you before it writes
anything.

```text
Set up XForge in this repository.

First ask me two questions and wait for my answers:
  1. Scaffold language — `en` or `zh-CN`?
  2. Which AI coding tool should XForge project into — codex, claude,
     cursor, opencode, or github-copilot?

Then, using my answers as <LANG> and <TOOL>:
  1. npm install -g @xforge/cli
  2. xforge version            → report the version and executablePath to me
  3. xforge init --language <LANG> --target <TOOL> --dry-run
  4. Show me that plan, then run the same command without --dry-run.
  5. xforge state --text       → confirm it reports mode: managed

Rules: run `xforge` directly. If the command is not found, stop and tell me —
never fall back to `npx xforge`, which resolves to an unrelated package of the
same name on npm. Do not create a package.json and do not run `npm install`
without `-g`: this project is not a Node project and XForge is a tool, not a
dependency. Never overwrite an existing file and never commit. If any step
reports a conflict or a diagnostic, stop and show me the JSON instead of
working around it.
```

**Why it asks first.** The language cannot be guessed in a non-interactive
session: initialization fails closed with `XFORGE_LANGUAGE_REQUIRED` rather than
picking one for you, because the Constitution and every Skill an Agent reads are
written in the language you choose here. The target decides which tool directory
receives the projection.

For a deeper, checklist-driven installation — adapting modules, targets and
Gates to an existing repository — point the Agent at the root-level
[Agent installation runbook](AGENT_INSTALL.md) instead:

```text
Install XForge into this repository by following AGENT_INSTALL.md exactly.
Do not overwrite existing files or commit changes. Stop and report conflicts.
```

### 2. Manual

```bash
npm install -g @xforge/cli@0.7.17
xforge version                       # confirm the version and where it resolved
xforge init --language en --dry-run
xforge init --language en
```

`--language en|zh-CN` overrides locale detection. Omit it only in an
interactive terminal, which will ask; a non-interactive run fails with an
actionable command rather than choosing for you. The Constitution, `XFORGE.md`,
Skills and sub-Agent instructions are installed in that language — one file per
document, under its canonical name — and every other Scaffold asset stays
English.

Then project the canonical Skills, agents, Rules, permission/MCP policies,
Hooks, and other supported assets into one tool:

```bash
xforge install --target codex --dry-run
xforge install --target codex
```

Use `init` for a project that has no `xforge/` yet, and `install` for one that
already does — `install` on an uninitialized directory reports
`XFORGE_PROJECT_NOT_FOUND`. Both take options only: the project root comes from
`--root <path>`, never as a positional argument.

`init --target <tool>` does both steps at once for a new project whose default
Scaffold needs no customization. Omitting `--target` from `install` projects
every target enabled in the Manifest.

### 3. Project-local, when one global version is not enough

A global install puts one version on the machine. Each project pins its own in
`xforge/manifest.yaml`, so two projects on different XForge versions cannot both
be satisfied by it — the mismatched one drops to Portable mode and refuses to
write, with `XFORGE_CLI_IDENTITY_MISMATCH`. Install per project when that
happens, or when a CI runner builds several projects:

```bash
npm install --save-dev --save-exact @xforge/cli@0.7.17
npx --no-install xforge version
```

Only here is `npx --no-install` correct, and both halves matter: `npx` resolves
the binary out of `node_modules/.bin`, which is not on your `PATH`, and
`--no-install` stops npm from fetching the unrelated `xforge` package when the
local one is missing. This is the one path that leaves `package.json` and
`node_modules` in the project.

### Verify, and diagnose a stale install

```bash
xforge version --text                # which build is answering, and from where
xforge state --text                  # mode: managed, declared vs actual
xforge check --text
```

**If a project reports `XFORGE_CLI_IDENTITY_MISMATCH`, the CLI answering is not
the version that project pinned.** `xforge version` reports both the version and
`executablePath`, which is what distinguishes an old global install from a
project-local one that is shadowing it. Resolve it by upgrading the project
(`xforge update`), upgrading the global install
(`npm install -g @xforge/cli@<version>`), or installing that project locally as
above. A stale install is never silent: writes are refused until the identities
agree.

Use the default JSON output instead of `--text` when another program or Agent
needs to consume the result.

## Using XForge for a change

The installed `xforge-*` Skills are the normal user interface. A typical first
request is:

```text
Use the xforge-propose Skill to create a Change for <goal>.
Choose the weakest Flow that is safe and explain the classification.
```

From there, `xforge-status` reports the portfolio of in-flight Changes and the
Stage each sits at, explains one Change in depth, and names the next legal
action without taking it; the lifecycle Skills handle the active stage:
`xforge-clarify`, `xforge-design`, `xforge-check`, `xforge-apply`, and
`xforge-verify`. `xforge-revise` updates planning artifacts while preserving
their consistency, and `xforge-scaffold` customizes the project-owned Agent
assets. `xforge-kanban` sits outside this lifecycle entirely and reports
Git-history activity on request, without reading or requiring any Change.

The underlying CLI loop is:

```bash
xforge state --change <change-id>
xforge check --change <change-id>
xforge transition --change <change-id> --to <next-stage> --dry-run
xforge transition --change <change-id> --to <next-stage>

# When state reports a ready work package:
xforge work-package dispatch --change <change-id> --package <package-id>

# When state reports a required approval. Copy the command from
# state.nextActions[] rather than assembling one: --for takes the id of the
# transition the approval unlocks, and approve refuses any other value
# instead of writing a receipt nothing will count.
xforge approve --change <change-id> --for <transition-id-or-archive> ...

xforge audit verify --change <change-id>
xforge archive --change <change-id> --dry-run
xforge archive --change <change-id>
```

Do not copy this sequence blindly: `state.nextActions` is authoritative, and a
Flow may require rework, extra Gates, external approval receipts, or remote
audit delivery before the next transition.

## Maintaining an installation

After editing canonical resources under `xforge/scaffold/` or changing the
selected resources in `xforge/manifest.yaml`, use:

```bash
xforge sync --dry-run
xforge sync --verify-digests
```

Use `xforge update --dry-run` followed by `xforge update` when targets,
Scaffold/CLI identity, or Adapter output changes. Use `xforge uninstall
--target <target> --dry-run` to preview safe removal of one target's managed
files.

## Moving a project onto a newer XForge

`xforge/scaffold/**` is seeded once by `init` and never updated afterwards, so a
project keeps the Skills, Rules and Gates it was created with until somebody
moves it. `xforge update` does not do this: it reprojects the Scaffold you
already have into `.claude/` and friends. `xforge upgrade-scaffold` is the one
that changes which Scaffold that is.

It never merges for you. It stages the incoming Scaffold beside your own,
snapshots what you have, and classifies every file — because which files differ
is arithmetic, while whether your wording in a Skill should give way to a newer
default is a question about your project. Nothing under `xforge/scaffold/` is
touched until you or an Agent decides.

Archive or finish open Changes first. A Change's remaining Stages would
otherwise run under Gates its Design never saw, and the command refuses rather
than let that happen silently.

### Hand this to your coding Agent

```text
Upgrade this project's XForge Scaffold to the version the installed CLI ships.

1. Run `npm i -g @xforge/cli@latest`, then `xforge version` to confirm it.
2. Run `xforge upgrade-scaffold --dry-run --text` and show me the plan. Stop if
   it refuses: open Changes must be archived first, and that is my decision.
3. Run `xforge upgrade-scaffold` to stage it. Nothing under `xforge/scaffold/`
   changes at this step.
4. Read `xforge/scaffold-<version>/MERGE.md`. It names every file that differs
   and every file that is new. Do not survey the Scaffold yourself — the plan is
   the statement of the job, and the identical files are already settled.
5. Merge, following that file. Adopt what the new version rules; keep what this
   project knows — a Gate carrying our real test command, wording we chose, a
   threshold somebody tuned. Where both cannot hold, stop and ask me.
6. Do NOT add anything to `xforge/manifest.yaml`. A file arriving with a release
   is not a decision to run it. List what arrived unselected and let me choose.
7. Never delete a file marked `project-only`, and never touch `xforge/changes/`,
   `xforge/specs/`, the audit chain, approvals, `constitution.md`, or
   `architecture.md`.
8. Finish with `xforge upgrade-scaffold --complete`, then `xforge install`, then
   `xforge doctor`.
9. Report: which side you took per changed file and why, the adoption count from
   step 8 quoted verbatim without grading it, and what awaits my decision.
```

Projects that select `xforge-upgrade-scaffold` can have the Agent invoke that
Skill instead; it carries the same rules with the authority boundaries attached.

### If it goes wrong

`xforge upgrade-scaffold --rollback` restores the Scaffold exactly as it stood
before staging. Exactly one snapshot is kept — the last upgrade's — because
arbitrary version travel would reintroduce the problem this replaces. It refuses
when the Scaffold changed after the upgrade completed, since rolling back would
discard that work; `--force` overrides. `xforge/upgrade-log.md` records every
completed upgrade and survives both the staged directory and the rollback.

## Important boundaries

- Runtime Hook and permission coverage is platform-specific and may require an
  explicit project trust step in the coding tool.
- The `runtime-audit` Hook ships as an unselected example: no dispatcher executes
  its `builtin: audit` action yet, so selecting it would have no effect.
- Generated Hooks invoke `xforge` from the project root so they
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
