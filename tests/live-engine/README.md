# Live engine end-to-end tests

This harness drives a real `claude` CLI call against an isolated, independent
project seeded at `tests/.tmp/live-engine-<scenario>`. It is excluded from
`npm run verify` (see `tests/README.md`) because it costs real provider tokens
and is not fully deterministic — run it on a schedule or by hand, not as a
merge gate.

The engine is allowed to edit only the isolated project. Approval signing and
delivery recording remain external deterministic harness operations, and the
repository `.env` is loaded without shell evaluation and never copied into
the sample project.

## What this validates that unit/integration tests cannot

- **A real npm install, not a build artifact call.** `setup.mjs` installs
  `@xforge/cli` into the isolated project's own `node_modules` — from the
  real npm registry (`--cli-source npm`, the default) or from a freshly
  `npm pack`ed local tarball (`--cli-source local`, for same-day regression
  testing of an uncommitted change without a registry round-trip or a real
  publish). Every later command in this harness invokes
  `npx --no-install xforge ...` with `cwd` set to that project — the same
  invocation form documented in the project's own `AGENTS.md` — never a
  hardcoded path to this repository's `xforge/dist/cli.js`.
- **A real `xforge init`.** `setup.mjs` does not copy `scaffold/payload` by
  hand; it installs the CLI, then runs a real
  `npx --no-install xforge init --target claude`, so init/install projection
  itself is exercised, not bypassed.
- **A real model reading real Skills, not scripted CLI calls standing in for
  one.** `run-engine.mjs` spawns `claude -p ...` with the isolated project as
  its working directory and a Skill-specific prompt; it is not a stub.
- **All three Flows, not just one.** `run-matrix.mjs --flow quick|solid|major`
  reads that Flow's own `xforge/flows/<name>.yaml` stage graph — stage order,
  which Skill each stage belongs to, which Approval policies gate a stage's
  exit, and each stage's work-package execution mode — and drives the run
  from that data. Adding a Flow or changing its stages does not require a new
  imperative script.
- **Coverage across all 13 `xforge-*` Skills**, not just the ones a single
  Change walkthrough happens to touch. See `coverage-matrix.yaml`.
- **Enterprise-shaped multi-approver governance**, not one bare signature.
  `approval-provider.mjs` reads the Flow's `governance.approvalPolicies`
  (`minApprovers`, `roles`, `separationOfDuties`) and produces that many
  distinct, role-diverse signed receipts — Major's `implementation-major`/
  `closing-major` policies each require 2 approvers in different roles.
- **Artifact quality, not just artifact existence.** `assert-artifact-outline.mjs`
  checks a produced `proposal.md`/`design.md`/`assurance.md`/`check-report.md`/
  `clarifications.md` against the exact `##` heading set the Flow's own
  `artifacts[].outline` defines (padding or omission both fail), and checks
  delta Specs for the presence of every `### Requirement:`/`#### Scenario:`/
  `- **WHEN**`/`- **THEN**` marker the outline template uses.

## Scenarios

```text
tests/live-engine/scenarios/
  quick/        propose -> apply -> verify (greeter: trivial, single-module, low risk)
  solid/        propose -> design -> check -> apply -> verify (task-ledger)
  major/        propose -> clarify -> design -> check -> apply -> verify (credential-store:
                risk high, security + dataMigration impact, a deliberately unresolved
                material question for Clarify to formally resolve)
  standalone/   explore, kanban, scaffold (fresh project, no active Change) and
                status, continue, revise, archive (piggyback on an in-progress
                quick/solid/major run — see coverage-matrix.yaml's notes for exactly where)
```

Each Flow scenario's `project-seed/` carries its own `TEST_REQUEST.md`,
`package.json`, and an immutable black-box `node:test` acceptance suite,
already validated against an independent reference implementation before
being committed — the model is expected to satisfy that suite, not to be
trusted to have specified it correctly itself.

## Running the matrix

```bash
npm run build

# Cheap, deterministic, no network/model access required — run this first:
node tests/live-engine/check-coverage.mjs

# Costs real provider tokens; run where npm registry + model API access exist:
node tests/live-engine/run-matrix.mjs --flow quick --cli-source npm
node tests/live-engine/run-matrix.mjs --flow solid --cli-source npm
node tests/live-engine/run-matrix.mjs --flow major --cli-source npm
```

Use `--cli-source local` for same-day regression testing of a local,
uncommitted CLI change (packs `./xforge` and installs from that tarball
instead of the registry). `--suite-budget`, `--budget`, `--max-attempts`, and
`--timeout-seconds` override the defaults (30 USD Flow budget, 3 USD
per-call budget capped to the remainder, 2 attempts per stage, 900 second
timeout). Missing provider cost accounting blocks all later calls in that
run instead of treating the cost as zero.

`run-matrix.mjs` prints a pass/fail summary (acceptance exit code, spend,
budget accounting) when it finishes. Per-stage engine output — cost, tokens,
turns, the model's own JSON result — is written to
`tests/.tmp/live-engine-results/<flow>-<stage>.json`, redacted of the auth
token and base URL; prompts and model prose are never written there.

For an OS-enforced boundary, `run-engine.mjs` (called internally by
`run-matrix.mjs`) accepts `--sandbox-launcher /absolute/path/to/launcher`;
the launcher receives `claude` followed by its arguments and must execute it
in the desired sandbox. Without a launcher, every call passes
`--allow-behavioral-isolation true`: the runner minimizes inherited
environment variables and relocates HOME/config/cache under `tests/.tmp`,
but this is not an operating-system security boundary.

Never put `approval-provider.mjs`, `run-xforge.mjs`, the approval secret, or
the repository `.env` inside an isolated project. Scenario prompts prohibit
parent-directory access; behavioral isolation is an explicit fallback, not a
sandbox guarantee.

## Extending coverage

Adding a Skill or a Flow (per
[docs/extending-skills-and-flows.md](../../docs/extending-skills-and-flows.md))
without adding it here is exactly the gap `check-coverage.mjs` is meant to
catch: it cross-references `coverage-matrix.yaml` against `manifest.yaml`'s
`scaffold.skills` and every Flow yaml's `stages[].skill`, and fails when
either side has an entry the other doesn't.
