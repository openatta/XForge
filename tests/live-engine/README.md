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

- **A real npm install, not a build artifact call — and installed the way the
  product documents.** `setup.mjs` installs `@xforge/cli` from the real npm
  registry (`--cli-source npm`, the default) or from a freshly `npm pack`ed
  local tarball (`--cli-source local`), into a directory *beside* the isolated
  project, and puts its `bin` on `PATH`. Every later command invokes a bare
  `xforge ...` with `cwd` set to the project — the global-install form v0.7.12
  documents and the project's own `AGENTS.md` tells an Agent to use — never a
  hardcoded path to this repository's `xforge/dist/cli.js`.

  It used to install into the project as a devDependency, which meant writing a
  `package.json` there first. That made **every scenario this harness can build a
  Node project**, and that was not a neutral detail: it is precisely the shape in
  which the shipped npm Gates reported `passed` having asserted nothing, so no
  number of runs here could have found that defect. A harness that cannot
  construct the failing shape cannot see the failure. A project now starts empty
  and receives only what its seed puts there, so a Rust, Go or Python scenario is
  possible.
- **A real `xforge init`.** `setup.mjs` does not copy `scaffold/payload` by
  hand; it installs the CLI, then runs a real
  `xforge init --target claude`, so init/install projection
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
- **Enterprise-shaped approval governance, driven by the Flow rather than by
  this harness.** `approval-provider.mjs` reads the Flow's
  `governance.approvalPolicies` (`minApprovers`, `roles`, `separationOfDuties`)
  and signs exactly what the policy asks for, through the mcp provider Major's
  `implementation-major`/`closing-major` require. Both currently ask for one
  approver: `separationOfDuties` is what carries the weight there, and it does
  not compare roles — it requires that the approver is not an implementer of the
  Change. `roles` is an eligibility filter, not a diversity requirement. The
  rationale is on `flows/major.yaml` itself; this file follows it rather than
  restating a number that can move.
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
  quick-python/ the same Flow and oracle on a genuinely non-Node project: pyproject.toml,
                a stdlib unittest suite, and no package.json anywhere
  quick-undeclared/
                the quick project with the answer removed: nothing says how it runs its
                tests and nobody is there to ask, so stopping is the pass
  solid/        propose -> design -> check -> apply -> verify (task-ledger)
  solid-contract/
                the same Stage graph on the solid-contract Flow (order-ledger): a two-module
                project whose interface between them is governed by a contract baseline, so the
                run has to declare an interface delta, record four declared Gate commands, and
                leave the baseline advanced
  major/        propose -> clarify -> design -> check -> apply -> verify (credential-store:
                risk high, security + dataMigration impact, a deliberately unresolved
                material question for Clarify to formally resolve)
  standalone/   scaffold, architect, kanban, upgrade-scaffold — each its own selectable
                scenario: one prepared project, one model call, one assertion on what the
                Skill left on disk; and
                status, status-blocked, revise (not selectable — they piggyback on an
                in-progress quick/solid/major run, see coverage-matrix.yaml's notes)
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
| `quick-python` | quick | non-Node | archived, **exactly 0 reworks**, `unit-tests` ran the declared Python command |
| `quick-undeclared` | quick | fail-closed | **stopped at verify**, `verification.unit-tests` still absent — inventing a command fails even if it is right |
| `solid` | solid | happy-path | archived, **exactly 0 reworks** |
| `solid-rework` | solid | rework | archived, **exactly 1 rework** |
| `solid-contract` | solid-contract | contract-governance | archived, **exactly 0 reworks**, and `xforge/contracts/` records every element the delta declared |
| `major` | major | adversarial | archived **or** `stopped-at-check` |
| `standalone-scaffold` | — | authoring | a project-owned Rule written **and** registered in the Manifest |
| `standalone-architect` | — | authoring | `xforge/architecture.md` written with real sections |
| `standalone-kanban` | — | read-only | reported without writing any governance state |
| `standalone-upgrade-scaffold` | — | merge | the project's own test command survived the merge, and no staged directory left behind |

A standalone scenario asserts the Skill's **observable effect**, never its prose: what the
final message claimed is not evidence, what it left on disk is.

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

### A seed may select resources, and adopt a Flow that ships as a template

`project-seed/manifest-patch.yaml` is merged into the Manifest `xforge init` produced rather than
replacing it: list-valued keys under `scaffold` are appended without duplicating, scalars are
replaced, everything else is left alone. A seed shipping a whole Manifest would pin the Scaffold
version, the CLI version and the target list into a fixture with no business knowing any of them,
and it would go stale silently, because the file stays valid as they move.

When the patch selects a Flow that is not in `xforge/flows/`, `setup.mjs` copies it from
`xforge/scaffold/flows/` — the same copy that Flow's own header documents as step one of adopting
it — and then runs `xforge install` so the lockfile and every projection reconcile. That way the
harness exercises the documented adoption route instead of carrying a duplicate of a shipped Flow
that would drift from it, invisibly, until a run failed for a reason unrelated to the run.

`solid-contract` is the only scenario using this today. Adoption itself is not what it tests: the
seed arrives already adopted, and whether an Agent can perform the adoption unaided is a separate
scenario nobody has written yet.

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
2. `implementation-major`'s mcp approval round-trip succeeded, leaving as many
   signed receipts as that policy's `minApprovers` asks for — see
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
policy holds as many receipts as `minApprovers` demands and each comes from a
role and a provider it admits, and every open blocker cites a path that exists —
and reports `outcome: "stopped-at-check"`
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

**The per-stage timeout sizes itself to the provider.** Roughly 95% of a
stage's wall clock is time waiting on the API, so unless you state
`--timeout-seconds` yourself the runner makes one trivial round trip to the
endpoint in `.env` and multiplies the default by `ceil(latency / 3s)`, capped
at ×4. A stated value is never scaled.

That exists because a fixed ceiling lost on a real endpoint: `major`'s check
stage runs 49 turns, and on the gateway this project is configured with
(~13s for a trivial call, ~7s per turn) its API time alone is 5.8 minutes.
It was killed twice at exactly 900s having produced nothing, then passed
every stage on the first attempt at 2700s. On a 1–2s/turn provider the same
run finishes in 15–20 minutes and 900s is ample.

**Every run reports the limits it ran under.** The timeline and the summary
envelope both carry `limits`: the four effective values, the shipped
defaults, which ones the caller stated, the probed latency and scale, and
`atDefaults`. A run at widened limits also prints a `warning: relaxed-limits`
line. Check `limits.atDefaults` before reading a verdict — an `archived`
reached at a raised ceiling is not the same claim as one reached at the
shipped default, and without this they were the same three words in the file.

## What a run costs, and which one to run

Every run here calls a real model against a real, freshly installed project.
There is no recorded mode and nothing is replayed: the only way to learn what an
Agent does with these Skills is to have an Agent do it.

That makes cost the thing to plan around. One standalone scenario is roughly
300k tokens and four minutes; all six is tens of millions of tokens and the
better part of an hour. So run the scenario that exercises what you changed
rather than the whole matrix:

| Changed | Run |
|---|---|
| A standalone Skill (`architect`, `upgrade-scaffold`, `scaffold`, `kanban`) | that Skill's own `standalone-*` scenario — one run, minutes |
| A Skill a Flow Stage names (`design`, `apply`, `check`, `verify`…) | one scenario that walks that Flow |
| A Flow, Gate, or the control plane | several, chosen for what they touch |
| Preparing a release | all six, deliberately |

The `Rejected` fix of 2026-08-17 is the worked example: it changed
`xforge-architect` alone, `standalone-architect` alone validated it in four
minutes, and both halves of the new rule were observed. The other five scenarios
would have added nothing.

**A named scenario is a runnable one.** `coverage-matrix.yaml` may only name scenarios listed in
`scenario-catalogue.mjs`, and `run-matrix.mjs` refuses to start if its own table and that catalogue
disagree. Both checks exist because they were missing: `xforge-scaffold` and
`xforge-upgrade-scaffold` were recorded as covered by `standalone-scaffold` and
`standalone-upgrade-scaffold`, the prompts existed, the runner rows did not, and `check-coverage.mjs`
reported `ok: true` throughout — it only ever compared Skill *names*. Two Skills were documented as
covered by runs that could not happen.

**The run is the product, and it is not saved anywhere else.** The isolated
project tree under `tests/.tmp/` and `tests/.tmp/live-engine-results/` are the
whole record of what happened — `clean-tmp.mjs` spares both by default for that
reason, and `--all` is the explicit opt-in to discarding them. A per-Stage
`contentRevision` is written into `<scenario>-timeline.json` as the run goes, so
a finished run can be read back stage by stage without re-running it.

**Why there is no recorded mode.** There was one, for two months: a `git bundle`
of the isolated project plus a manifest naming the Agent's commits, replayed by
restoring each Stage's authored diff and genuinely re-executing everything
around it. It was removed in favour of running live, on the evidence it
produced.

The recordings were never once replayed. Every defect these runs have found came
from the run itself — the Skill authority contradiction, the harness's fake
parallelism, a correct refusal scored as a missing Artifact, the `major` fixture
that had never been asked how it scans. None of those is reachable by replay,
because a replay substitutes the model's output and therefore cannot test the
model. Meanwhile any change to any payload file invalidated every recording at
once, so the recordings were usually stale, and re-recording cost a full live
run of everything — twice paid to validate one edit to one standalone Skill's
prose.

There was also a hazard that only replay had: replay re-signs approvals, so a
replayed receipt lands at a fresh UUID and a principle citing the recorded
filename cannot resolve. Four fixes were tried; three failed. The one that
worked was not a replay fix at all — **`constitution-check` now refuses a
principle whose citations are *all* approval receipts**, because a receipt
records that someone approved a transition, not why the Change satisfies the
principle. `xforge-check`'s `SKILL.md`/`SKILL_cn.md` and the `constitution-check`
artifact `instruction` in `solid.yaml`/`major.yaml` say the same thing before the
Gate has to.

Note which half of that is load-bearing. This directory's own history is the
argument: the hazard was documented here, in prose, and documenting it did not
prevent a single recurrence. A rule an Agent is asked to remember is not the
same rule as one the Gate applies — so the Skill text explains the reason and
the Gate is what enforces it. That conclusion outlived the feature that produced
it, which is why it is still here.

**Every project here was a Node project until 2026-08-17, and not by choice.**
`setup.mjs` installed `@xforge/cli` as a devDependency, so it wrote a
`package.json` before any seed was overlaid. That hid a real defect for as long
as it was true: the shipped `unit-tests` and `security-scan` Gates ran npm, and
on a project *without* a `package.json` they reported `passed` having asserted
nothing — so a `must` Rule lost its only enforcement and an archive's mandatory
Gate was empty. No number of runs here could have surfaced it.

The CLI is now installed beside the project rather than inside it, so a seed with
no `package.json` produces a project with none, and a non-Node scenario is
buildable. `quick-undeclared` records the other half — whether an **Agent**
invents an answer when none is available — which no static test can show.

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
