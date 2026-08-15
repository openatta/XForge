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
- **Coverage across all 10 `xforge-*` Skills**, not just the ones a single
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
  standalone/   kanban, scaffold (fresh project, no active Change) and
                status, status-blocked, revise (piggyback on an in-progress
                quick/solid/major run — see coverage-matrix.yaml's notes for exactly where)
```

Each Flow scenario's `project-seed/` carries its own `TEST_REQUEST.md`,
`package.json`, and an immutable black-box `node:test` acceptance suite,
already validated against an independent reference implementation before
being committed — the model is expected to satisfy that suite, not to be
trusted to have specified it correctly itself.

### Scenarios are not Flows, and they are scored by intent

A directory under `scenarios/` holds fixtures and prompts; a *scenario* is an
entry in `run-matrix.mjs`'s table, naming the Flow to drive and what the run
must show. More than one scenario can drive the same Flow, so `--scenario`
selects the entry and `--flow` remains an alias for the three whose names
coincide. Every path a run writes is keyed by the scenario, so two can run at
once.

| scenario | flow | intent | must show |
| --- | --- | --- | --- |
| `quick` | quick | happy-path | archived, **exactly 0 reworks** |
| `solid` | solid | happy-path | archived, **exactly 0 reworks** |
| `solid-rework` | solid | rework | archived, **exactly 1 rework** |
| `major` | major | adversarial | archived **or** `stopped-at-check` |

The rework count is asserted, not tolerated. `maxReworks` only ever bounded
oscillation, so a scenario meant to prove the rework path worked passed
identically when it never reworked — a live Solid run did exactly that. A
happy-path scenario now fails if anything sends work back, and `solid-rework`
fails if nothing does.

`solid-rework` walks the same Stage graph as `solid` and differs in one thing:
after Design, the harness appends a claim to `design.md` that contradicts the
seeded acceptance suite (the suite asserts a corrupt store exits non-zero; the
planted Design says it exits 0). Check is expected to find that contradiction,
block, and send the work back to `design`, which is what `check.reworkTo` lists
it for — and the second pass must clear it. Unlike Major's, this rework is
constructed, so the expectation can be exact.

### Major's expected outcome: often stops at Check, and that is a pass, not a failure

Unlike quick/solid, a major (`credential-store`) run reaching `verify`/archive
is not the bar for "the product works." `credential-store` is deliberately a
security-heavy Spec (secret length limits, "never appears in output"
guarantees, v1→v2 migration atomicity) against a fixed, black-box acceptance
suite that cannot be extended mid-run. Across independent runs, the Check
Agent has repeatedly found a *different* specific requirement the Spec
claims but the immutable suite does not actually verify (a CLI argument-name
mismatch in one run; untested >1024-character secrets and an untested
no-leakage guarantee in the next) — each one a real, well-reasoned violation
of the `observable-requirements-are-tested` Rule, each with exact file/line
citations, each correctly blocking `check → apply` (`gate:check-findings:failed`)
before implementation starts.

**This is the intended outcome, not a bug in XForge or in this harness.**
A major run that stops at Check with a specific, correctly-attributed
blocker is validating exactly what Major exists to validate — self-answer
the question "did the pass-through governance chain work?" this way, not by
"did it reach archive?":

1. propose → clarify → design → check all completed and produced their
   required Artifacts and evidence ledgers.
2. `implementation-major`'s mcp approval round-trip succeeded with two
   distinct-role receipts (`owner` + `maintainer`) — see
   `xforge/changes/<id>/approvals/implementation-major/*.json` in the
   project root reported by `setup.mjs`.
3. `check-findings` and `constitution-check` ran and either passed cleanly
   or blocked with a finding that cites real Artifact/test evidence — not
   prose the model could have fabricated.

**These three points are now checked by the harness, not by you.** They used to
live only in this section, so a correct Major run exited non-zero and read as a
crash until someone came and applied them by hand. When Major exhausts its
reworks at Check, `run-matrix.mjs` verifies each point against the project on
disk — every Stage up to Check produced its declared Artifacts, the Approval
policy holds as many distinct-role receipts as it demands, and every open
blocker cites a path that exists — and reports `outcome: "stopped-at-check"`
with exit code 0 when they hold. If any point fails, the run fails and says
which. The acceptance suite is not run for this outcome: Apply never happened,
so there is no implementation for it to judge.

If a future run needs major to reach `apply`/`verify`/archive specifically
(e.g. to test *those* stages, which quick/solid's own successful runs
already exercise via the same underlying mechanisms), the acceptance suite
under `major/project-seed/test/` will likely need broadening to cover
whatever property the model's Proposal/Design claimed that round — expect
to do this more than once, since different runs surface different gaps.
Chasing every one is not required for a passing regression; one clean
propose→check pass with a correctly-attributed blocker (or a clean
check-findings pass) is sufficient evidence the governance chain works.

## Running the matrix

```bash
npm run build

# Cheap, deterministic, no network/model access required — run this first:
node tests/live-engine/check-coverage.mjs

# Costs real provider tokens; run where npm registry + model API access exist:
node tests/live-engine/run-matrix.mjs --flow quick --cli-source npm
node tests/live-engine/run-matrix.mjs --flow solid --cli-source npm
node tests/live-engine/run-matrix.mjs --flow major --cli-source npm
node tests/live-engine/run-matrix.mjs --scenario solid-rework --cli-source npm
```

Use `--cli-source local` for same-day regression testing of a local,
uncommitted CLI change (packs `./xforge` and installs from that tarball
instead of the registry). `--suite-budget`, `--budget`, `--max-attempts`, and
`--timeout-seconds` override the defaults (30 USD Flow budget, 3 USD
per-call budget capped to the remainder, 2 attempts per stage, 900 second
timeout). Missing provider cost accounting blocks all later calls in that
run instead of treating the cost as zero.

## Recording and replaying a run

A live run costs real money and real minutes, which makes it a poor loop to
iterate the *tooling* in. Recording one lets the CLI, the Gates, the control
plane, the Approval and work-package protocols, archive, and this harness be
regression-tested for free.

```bash
# 1. Record: run the scenario live, then package the run it left behind.
node tests/live-engine/run-matrix.mjs --scenario solid --cli-source local
node tests/live-engine/record-cassette.mjs --scenario solid

# 2. Replay: no model calls, no API key needed, seconds instead of minutes.
node tests/live-engine/run-matrix.mjs --scenario solid --replay solid --cli-source local
```

**What is recorded is the project's Git history, not the model's responses.**
That is forced by what exists: every call passes `--no-session-persistence`, so
no tool-call transcript is written anywhere, and a recorded response could not
reproduce file-system state even if one were. What the model *did* is already
recorded exactly — the harness commits after every Stage — so a cassette is a
`git bundle` of the isolated project plus a manifest saying which commits were
the Agent's.

On replay, only the Agent's own contribution is applied: the diff between a
recorded Stage commit and its parent. Everything else genuinely re-executes —
approvals are re-signed, Gates re-run, work packages re-dispatched, the archive
transaction performed again. Restoring whole trees would reinstate their outputs
instead of testing them.

Each Stage is then checked against the recording's `contentRevision`.
`core/revision.ts` derives that value from governed content and the policy
snapshot, with no commit id or timestamp in it, so identical trees must produce
an identical revision — and any drift in how content is digested fails
immediately, at the Stage that caused it.

**A replay cannot tell you whether a Skill is comprehensible or whether an Agent
obeys it.** Four of the defects the 2026-08-13 runs found were model-behaviour
defects that no replay would have caught. So a cassette records the fingerprint
of the Scaffold it was made against, and replaying against a changed Scaffold is
**refused**, with the re-record commands printed. Change a Skill, Flow, Gate,
Rule or policy, and you owe a live run — enforced rather than remembered.

`run-matrix.mjs` prints a pass/fail summary (acceptance exit code, spend,
budget accounting) when it finishes. Per-stage engine output — cost, tokens,
turns, and the engine's own JSON result envelope — is written to
`tests/.tmp/live-engine-results/<scenario>-<stage>.json`, redacted of the auth
token and base URL. Prompts are never written there. The model's **final
response is**, in that envelope's `result` field, because it is what the engine
returns; a stage's closing report therefore lands on disk and these files should
be treated as run output, not as anonymous telemetry. The turn-by-turn
transcript is not written anywhere: every call passes
`--no-session-persistence`, so no tool-call history survives the run.

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
