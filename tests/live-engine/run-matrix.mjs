import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';
import { spawnXforge, runXforgeJson, tryXforgeJson } from './xforge-cli.mjs';
import { assertLiveEnginePolicy, createLiveEnginePolicy, resetLiveEngineStageAttempts } from './policy.mjs';
import { assertCassetteStillApplies, readCassette } from './cassette.mjs';

/**
 * Data-driven live-engine matrix runner. For a Flow scenario (quick/solid/major), this reads
 * that Flow's own `xforge/flows/<name>.yaml` stage graph — stage order, which Skill each stage
 * belongs to, which Approval policies gate a stage's exit, and each stage's work-package
 * execution mode — and drives one real `claude` call per stage against the isolated,
 * npm-installed project, exactly the sequence a real Agent session would go through. It does
 * not hand-roll a separate imperative script per Flow: the stage graph itself decides what
 * happens next, so adding a Flow or changing one's stages does not require editing this file.
 *
 * What is NOT derivable from the Flow yaml alone — which scenario/Change id to use, and where a
 * standalone-Skill scenario (status/continue/revise/archive) piggybacks on an in-progress run —
 * is kept as a small explicit table below, not invented generically.
 */

/* fileURLToPath, not .pathname + path.resolve: a file:// URL's .pathname keeps a leading
   slash before a Windows drive letter (/D:/...), which path.resolve does not strip -- it
   prepends the cwd's own drive instead, producing a broken D:\D:\... path. */
const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scriptsRoot = path.join(repositoryRoot, 'tests', 'live-engine');
const scenariosRoot = path.join(scriptsRoot, 'scenarios');
const temporaryRoot = path.join(repositoryRoot, 'tests', '.tmp');
const resultsRoot = path.join(temporaryRoot, 'live-engine-results');

/*
 * Scenarios, not Flows. A scenario names a Flow to drive and what to expect of it, and more than one
 * can drive the same Flow — `solid` and `solid-rework` walk the same Stage graph and differ only in
 * whether the harness plants a contradiction on the way. `--scenario` selects the entry, `flow`
 * selects the yaml; every path the run writes (results, temp roots, logs) is keyed by the scenario
 * so two of them can run at once.
 *
 * `expect` is the point of the split. A run that tolerates rework proves nothing about rework: a
 * live Solid run passed with none, and would have passed identically had the whole rework path been
 * broken. Each scenario now states the number it must see, and the run fails on either side of it.
 */
const SCENARIOS = {
  quick: {
    flow: 'quick',
    changeId: 'greeter',
    intent: 'happy-path',
    expect: { reworks: 0, outcome: 'archived' },
    inject: { afterStage: 'apply', prompt: 'standalone/status.md', stageLabel: 'standalone-status' },
  },
  solid: {
    flow: 'solid',
    changeId: 'task-ledger',
    intent: 'happy-path',
    /* The full-featured clean walk: work packages, an Approval-gated Stage, and a mid-Flow upstream
       requirement change the Agent must absorb — all without a Stage ever sending work back. */
    expect: { reworks: 0, outcome: 'archived' },
    inject: {
      afterStage: 'propose',
      prompt: 'standalone/revise.md',
      stageLabel: 'standalone-revise',
      beforeInject: appendRequirementToTaskLedgerRequest,
    },
  },
  'solid-rework': {
    flow: 'solid',
    changeId: 'task-ledger',
    intent: 'rework',
    /*
     * The same Flow as `solid`, with a defect planted where Check must find it. `mutate` writes a
     * Design section that contradicts the seeded acceptance suite — the suite is immutable and
     * asserts the corrupt-store path exits non-zero, so a Design claiming it exits 0 is a real
     * contradiction between governing Artifacts, which is exactly what Check exists to catch and
     * what `check.reworkTo` lists `design` for.
     *
     * Unlike Major's, this rework is constructed rather than emergent: the harness knows what the
     * defect is, so the expectation can be exact — one rework, and a second pass that clears it.
     */
    maxReworks: 1,
    expect: { reworks: 1, outcome: 'archived' },
    /*
     * The same upstream requirement edit `solid` performs, and for the same reason: the shared seed's
     * acceptance suite asserts `list --limit` and names it REQ-TASK-006, a Requirement that only
     * enters the Change through this injection. Omitting it left the suite testing behaviour no
     * delta Spec declared, and Verify correctly refused to call that archive-ready — a scenario
     * built on another's fixtures inherits what those fixtures assume.
     */
    inject: {
      afterStage: 'propose',
      prompt: 'standalone/revise.md',
      stageLabel: 'standalone-revise',
      beforeInject: appendRequirementToTaskLedgerRequest,
    },
    mutate: { afterStage: 'design', apply: contradictTaskLedgerDesign },
  },
  major: {
    flow: 'major',
    changeId: 'credential-store',
    intent: 'adversarial',
    /*
     * Major is adversarial, not a baseline, and it is scored differently on purpose. Its delta Spec
     * is written by this run's own Propose Agent while `test/**` is seeded and immutable, so the
     * Spec routinely promises a property the fixed suite cannot verify — a real finding, differently
     * worded every run (`F-001` reworkTo clarify one round, `B1` reworkTo propose the next). Neither
     * the finding nor its target is reproducible, so neither can be asserted. What is assertable is
     * whether the governance chain did its job, which `stopped-at-check` checks point by point.
     */
    maxReworks: 1,
    expect: { outcome: ['archived', 'stopped-at-check'] },
    inject: { afterStage: 'check', prompt: 'standalone/status-blocked.md', stageLabel: 'standalone-status-blocked' },
  },
};

function options(argv) {
  const result = { 'cli-source': 'npm', 'suite-budget': '30', budget: '3', 'max-attempts': '2', 'timeout-seconds': '900' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Expected key/value options.');
    result[key.slice(2)] = value;
  }
  /* `--flow` still selects a scenario by name, because for three of the four the two coincide and
     every existing invocation spells it that way. `--scenario` is what a scenario sharing another's
     Flow needs, and it wins when both are given. */
  result.scenario ??= result.flow;
  if (!SCENARIOS[result.scenario]) throw new Error(`--scenario must be one of: ${Object.keys(SCENARIOS).join(', ')}`);
  return result;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commit(projectRoot, message) {
  run('git', ['add', '.'], projectRoot);
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }).stdout.trim();
  if (!status) return;
  run('git', ['commit', '--quiet', '-m', message], projectRoot);
}

function changePath(changeId, generates) {
  return path.posix.join('xforge', 'changes', changeId, generates);
}

/**
 * Where a Transition the control plane refused should send the work back to — read off the Change's
 * own findings ledger rather than chosen here. Each finding carries `reworkTo`, and the Flow's
 * `reworkTo` on the Stage being left says which of those the model actually permits; a target that
 * satisfies neither is not a rework the harness may invent, so this returns null and the caller
 * fails with the block spelled out.
 */
function declaredReworkTarget(projectRoot, envelope, stage) {
  if (!(envelope.diagnostics ?? []).some((item) => item.code === 'XFORGE_TRANSITION_BLOCKED')) return null;
  const ledger = path.join(projectRoot, changePath(scenarioConfig.changeId, 'evidence/check-findings.yaml'));
  let findings;
  try { findings = parse(readFileSync(ledger, 'utf8'))?.findings ?? []; } catch { return null; }
  const permitted = stage.reworkTo ?? [];
  for (const finding of findings) {
    if (finding?.status !== 'open' || finding?.severity !== 'blocker') continue;
    if (permitted.includes(finding.reworkTo)) return finding.reworkTo;
  }
  return null;
}

/**
 * Reads the Change's State without treating a governed refusal as a harness error.
 *
 * `state` exits non-zero whenever it has an `error` diagnostic to report — an Agent that wrote an
 * invalid `work-packages.yaml`, say — and that is the command working: the envelope is complete and
 * the diagnostics are the answer. Reading it through the throwing helper turned a finding the Flow
 * was about to act on into a stack trace one call earlier, and lost the diagnostics with it.
 */
function changeState(projectRoot) {
  return tryXforgeJson(projectRoot, ['state', '--change', scenarioConfig.changeId]).data.change;
}

/**
 * Gives every Stage the Flow is about to walk again its attempt budget back. Called only on a
 * rework, where re-entering a Stage is a fresh visit rather than a retry of the failed one.
 */
async function reopenStageAttempts(policyPath, stageIds) {
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  resetLiveEngineStageAttempts(policy, stageIds);
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
}

/**
 * Splits a recorded Stage's files into what the Agent wrote and what the CLI produced for it.
 *
 * A Stage commit holds both, because an Agent authors an Artifact and then runs `xforge check` or
 * `xforge transition` in the same turn. Only the first half may be restored on a replay. The second
 * half is the tooling under test: transition receipts are a hash chain, and restoring one recorded
 * against the previous run's chain while this run builds its own forks it outright
 * (`XFORGE_TRANSITION_CHAIN_INVALID`, which is how this was found). Gate Evidence, the audit log and
 * the work-package records are the same kind of thing — regenerating them is the point of replaying.
 *
 * `change.yaml` stays on the authored side despite living beside them: it holds the Flow, the
 * classification and the scope the Agent declared, and no governance state at all — that is entirely
 * in the receipts. Excluding it made the Change cease to exist and `state` return nothing.
 */
function isAgentAuthored(file) {
  const machineOwned = [
    /\/evidence\/receipts\//,
    /\/evidence\/audit\//,
    /\/evidence\/agents\//,
    /\/evidence\/[^/]+\.json$/,
  ];
  return !machineOwned.some((pattern) => pattern.test(`/${file}`));
}

/**
 * Replays one recorded Stage in place of calling the model.
 *
 * Only the Agent's own contribution is applied — the diff between the recorded Stage commit and its
 * parent — never the whole recorded tree. Everything the harness and the CLI did around it is
 * re-executed for real on this run, which is the entire point: approvals are re-signed, Gates are
 * re-run, work packages are re-dispatched, the archive transaction happens again. A whole-tree
 * checkout would restore their outputs instead of testing them.
 */
function applyRecordedStage(projectRoot, stageId) {
  /*
   * The nth visit to a Stage takes the nth recording of it. A Flow that reworks walks the same Stage
   * more than once and each visit produced different content — `solid-rework` records `design`
   * twice, the second time with the planted contradiction removed. Looking a Stage up by name alone
   * replayed the first visit both times and put the defect back, which the `contentRevision`
   * assertion then caught. Nothing else in the cassette is positional, so the counter lives here.
   */
  const occurrence = (replayVisits.get(stageId) ?? 0);
  replayVisits.set(stageId, occurrence + 1);
  const step = replay.steps.filter((candidate) => candidate.stage === stageId)[occurrence];
  if (!step) {
    /*
     * A Stage the recording walked but committed nothing for wrote nothing, and replaying it is
     * correctly a no-op. The read-only Skills are like this — `standalone-status` runs `xforge
     * status` and reports, so `commit` finds an unchanged tree and skips. The timeline still has an
     * entry for it, which is what separates "produced nothing" from "never happened": a Stage in
     * neither list is a Flow that reached somewhere the recording never did, and that is a real
     * divergence rather than a missing file.
     */
    const recorded = (replay.stages ?? []).some((candidate) => candidate.stage === stageId);
    /* The archive prompt is the other shape of this: a standalone Skill exercise the Agent is
       expected to end by reporting that closing Approval blocks it, so it writes nothing and older
       cassettes carry no timeline entry for it either. Newer ones do — the entry is written below —
       and until those replace these, its name is enough to tell it apart from a real divergence. */
    if (recorded || stageId === 'archive') {
      process.stdout.write(`${JSON.stringify({ replayed: stageId, files: 0, note: 'nothing recorded to apply; the Stage wrote nothing' })}\n`);
      return;
    }
    throw new Error(`Cassette "${replay.scenario}" never reached ${stageId}. The Flow walked to a Stage the recording did not, which is a divergence, not a missing file.`);
  }
  const changes = cassetteGit(['diff', '--name-status', step.parent, step.commit]).trim();
  const applied = [];
  const regenerated = [];
  for (const line of changes ? changes.split('\n') : []) {
    const [status, ...rest] = line.split('\t');
    const file = rest[rest.length - 1];
    if (!isAgentAuthored(file)) { regenerated.push(file); continue; }
    if (status.startsWith('D')) {
      rmSync(path.join(projectRoot, file), { force: true });
    } else {
      cassetteGit(['--work-tree', projectRoot, 'checkout', step.commit, '--', file]);
    }
    applied.push(file);
  }
  /* `git checkout` against a foreign work tree stages what it writes into the cassette's index;
     resetting keeps that index from carrying over into the next step's diff. */
  cassetteGit(['reset', '--quiet']);
  /*
   * Re-run `xforge check` only where the recording shows the Agent ran it — that is, where its turn
   * produced Gate Evidence. Running it after every Stage instead looks harmless and is not: at Apply
   * it regenerates the work package's verification record before the delivery is bound, so the
   * delivery diff then contains a file outside the package's `write_paths` and `apply -> verify`
   * blocks on a boundary the Worker never crossed. When the tooling runs matters as much as whether
   * it runs, and the recording is the statement of when.
   */
  if (regenerated.some((file) => /\/evidence\/[^/]+\.json$/.test(`/${file}`))) {
    tryXforgeJson(projectRoot, ['check', '--change', scenarioConfig.changeId]);
  }
  process.stdout.write(`${JSON.stringify({
    replayed: stageId, commit: step.commit.slice(0, 8), restored: applied.length, regenerated: regenerated.length,
  })}\n`);
}

async function runEngine({ projectRoot, scenario, stageId, promptRelative, policyPath, options: cliOptions }) {
  if (replay) return applyRecordedStage(projectRoot, stageId);
  const promptPath = path.join(scenariosRoot, promptRelative);
  const outputPath = path.join(resultsRoot, `${scenario}-${stageId}.json`);
  const args = [
    '--root', projectRoot,
    '--prompt', promptPath,
    '--output', outputPath,
    '--stage', stageId,
    '--policy', policyPath,
    '--suite-budget', cliOptions['suite-budget'],
    '--budget', cliOptions.budget,
    '--max-attempts', cliOptions['max-attempts'],
    '--timeout-seconds', cliOptions['timeout-seconds'],
    '--allow-behavioral-isolation', 'true',
  ];
  /*
   * `maxAttemptsPerStage` was only ever a budget cap: the policy reserved a second attempt that
   * nothing then took, because one non-zero engine exit threw and ended the Flow. A live run lost
   * two Flows to a single provider stall that way, several Stages deep, with the granted attempt
   * unused. Only a failure the model did not cause is retried — a provider stall or a stage the
   * watchdog killed. `provider_failure` covers a real refusal too, but a refusal reproduces on the
   * retry and fails the same way one attempt later, whereas a stall usually does not. The policy
   * stays the authority on how many attempts exist; this only stops leaving one on the table.
   */
  const transient = new Set(['provider_failure', 'environment_blocked']);
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(process.execPath, [path.join(scriptsRoot, 'run-engine.mjs'), ...args], {
      encoding: 'utf8', stdio: 'inherit',
    });
    if (result.status === 0) return;
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    const classification = policy.stages?.[stageId]?.runs?.at(-1)?.classification;
    const exhausted = (policy.stages?.[stageId]?.attempts ?? attempt) >= policy.maxAttemptsPerStage;
    if (!transient.has(classification) || exhausted) {
      throw new Error(`Live engine call failed for ${scenario}:${stageId} (${classification ?? 'unclassified'}, attempt ${attempt}). See ${outputPath}.`);
    }
    process.stdout.write(`${JSON.stringify({ retry: attempt + 1, stage: stageId, cause: classification })}\n`);
  }
}

function assertArtifactOutline({ projectRoot, flowName, artifactId, file, mode }) {
  const args = ['--root', projectRoot, '--flow', flowName, '--artifact', artifactId, '--file', file];
  if (mode) args.push('--mode', mode);
  const result = spawnSync(process.execPath, [path.join(scriptsRoot, 'assert-artifact-outline.mjs'), ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  if (result.status !== 0 || !json?.ok) {
    throw new Error(`Outline check failed for ${flowName}:${artifactId} (${file}): ${JSON.stringify(json ?? result.stdout)}`);
  }
  return json;
}

async function appendRequirementToTaskLedgerRequest(projectRoot) {
  const requestPath = path.join(projectRoot, 'TEST_REQUEST.md');
  const current = await readFile(requestPath, 'utf8');
  const addition = `\n### REQ-TASK-006 分页查询\n\n\`node src/cli.mjs list --limit <n>\` 只返回按 ID 升序排列的前 n 条任务；\n\`--limit\` 与 \`--status\` 可以同时使用；\`--limit\` 非正整数返回 USAGE_ERROR。\n`;
  await writeFile(requestPath, `${current.trimEnd()}\n${addition}`);
  commit(projectRoot, 'Upstream requirement change: add REQ-TASK-006 (harness-simulated stakeholder edit)');
}

/**
 * Whether a Stage produced the Artifact its Flow declares, allowing for the ones declared as a glob.
 *
 * `delta-specs` generates `specs/**\/*.md` — a pattern, not a filename — because a Change may carry
 * several delta Specs and cannot know their names in advance. Treating that string as a path made
 * the Major criterion report that Propose "never produced specs/**\/*.md" on a run whose Spec was
 * sitting right there, which is the wrong answer to the right question: what matters is that the
 * Stage left something behind, not what it happened to call it.
 */
function producedArtifact(projectRoot, generates) {
  const target = path.join(projectRoot, changePath(scenarioConfig.changeId, generates));
  if (!generates.includes('*')) return existsSync(target);
  const root = path.join(projectRoot, changePath(scenarioConfig.changeId, generates.split('*')[0]));
  const extension = path.extname(generates) || '';
  const walk = (directory) => {
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    return entries.some((entry) => (entry.isDirectory()
      ? walk(path.join(directory, entry.name))
      : entry.name.endsWith(extension)));
  };
  return walk(root);
}

/**
 * Decides whether a Flow that ran out of reworks at Check earned that verdict, point by point.
 *
 * `tests/live-engine/README.md` states the criterion in prose and a human had to apply it, which is
 * why a correct Major run exited non-zero and read as a crash. The three points are checked here
 * instead, against the project on disk:
 *
 *  1. Every Stage up to and including Check produced the Artifacts its Flow declares. A chain that
 *     stopped because an Agent skipped its work is a failure, not a governance result.
 *  2. The Approval round-trip the Check Stage's exit requires actually happened, with as many
 *     distinct-role receipts as the policy demands. This is what proves the enterprise path ran
 *     rather than being quietly skipped.
 *  3. The blocker cites evidence that exists. A finding whose `refs` point at nothing is prose the
 *     model could have invented, and it is the whole difference between "the Gate found something"
 *     and "the Gate said something".
 */
function assertStoppedAtCheck(projectRoot, flowDefinition, checkStage) {
  const problems = [];

  const upTo = [];
  for (const stage of flowDefinition.stages) {
    upTo.push(stage);
    if (stage.id === checkStage.id) break;
  }
  for (const stage of upTo) {
    for (const artifactId of stage.produces ?? []) {
      const artifact = flowDefinition.artifacts.find((entry) => entry.id === artifactId);
      if (!artifact) continue;
      if (!producedArtifact(projectRoot, artifact.generates)) {
        problems.push(`${stage.id} never produced ${artifact.generates}.`);
      }
    }
  }

  for (const policyId of checkStage.exit?.approvals ?? []) {
    const directory = path.join(projectRoot, changePath(scenarioConfig.changeId, path.posix.join('approvals', policyId)));
    let receipts = [];
    try {
      receipts = readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')))
        .filter((receipt) => receipt.decision === 'approve');
    } catch { /* directory missing is reported by the emptiness check below */ }
    const policy = (flowDefinition.governance?.approvalPolicies ?? []).find((entry) => entry.id === policyId);
    const required = policy?.minApprovers ?? 1;
    const roles = new Set(receipts.map((receipt) => receipt.approver?.role).filter(Boolean));
    if (receipts.length < required) problems.push(`${policyId} holds ${receipts.length} approval receipts, needs ${required}.`);
    if (policy?.separationOfDuties && roles.size < required) {
      problems.push(`${policyId} requires distinct roles but its receipts cover only ${[...roles].join(', ') || 'none'}.`);
    }
  }

  const ledgerPath = path.join(projectRoot, changePath(scenarioConfig.changeId, 'evidence/check-findings.yaml'));
  let blockers = [];
  try {
    blockers = (parse(readFileSync(ledgerPath, 'utf8'))?.findings ?? [])
      .filter((finding) => finding?.severity === 'blocker' && finding?.status === 'open');
  } catch { problems.push('check-findings.yaml is missing or unreadable.'); }
  if (blockers.length === 0) problems.push('No open blocker: the Flow stopped at Check without a finding that explains why.');
  for (const blocker of blockers) {
    const refs = blocker.refs ?? [];
    if (refs.length === 0) { problems.push(`Blocker ${blocker.id} cites nothing.`); continue; }
    /* Refs are written relative to the Change or to the project; a blocker that resolves under
       either is citing something real, which is all this point is asking. */
    for (const ref of refs) {
      const asProject = path.join(projectRoot, ref);
      const asChange = path.join(projectRoot, changePath(scenarioConfig.changeId, ref));
      if (!existsSync(asProject) && !existsSync(asChange)) {
        problems.push(`Blocker ${blocker.id} cites ${ref}, which does not exist.`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`${scenarioName} stopped at Check without earning it:\n  - ${problems.join('\n  - ')}`);
  }
  return { blockers: blockers.map((finding) => ({ id: finding.id, reworkTo: finding.reworkTo, refs: finding.refs })) };
}

/**
 * Plants the defect the `solid-rework` scenario exists to have found.
 *
 * The claim contradicts `test/task-ledger.acceptance.mjs`, which is seeded, immutable, and asserts
 * that a corrupt store exits 1 with `DATA_INVALID` and leaves the file untouched. Writing the
 * opposite into Design makes two governing Artifacts disagree — the condition `xforge-check` is
 * told to treat as a blocker, and the reason `check.reworkTo` lists `design`.
 *
 * It is appended under the Design outline's own headings rather than as a new section, because the
 * outline is a contract the harness asserts elsewhere; a stray `##` would fail the run for the wrong
 * reason.
 */
async function contradictTaskLedgerDesign(projectRoot) {
  const designPath = path.join(projectRoot, changePath('task-ledger', 'design.md'));
  const current = await readFile(designPath, 'utf8');
  const contradiction = '\n**Corrupt store handling (revised):** when the store file cannot be parsed, the CLI'
    + ' treats it as an empty ledger, prints `{"data":{"tasks":[]}}` on stdout and exits **0**. It does not'
    + ' report `DATA_INVALID`, because a malformed store is recoverable rather than an error condition.\n';
  await writeFile(designPath, `${current.trimEnd()}\n${contradiction}`);
  commit(projectRoot, 'Planted Design/acceptance-suite contradiction for the rework scenario');
}

async function runApprovals({ projectRoot, policyIds, transition, changeId, simulateRejectionFor }) {
  for (const policyId of policyIds) {
    const args = [
      '--root', projectRoot, '--change', changeId, '--transition', transition, '--policy', policyId,
    ];
    if (policyId === simulateRejectionFor) args.push('--simulate-rejection', 'true');
    const result = spawnSync(process.execPath, [path.join(scriptsRoot, 'approval-provider.mjs'), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) throw new Error(`Approval provider failed for policy ${policyId}: ${result.stderr || result.stdout}`);
  }
}

const selected = options(process.argv.slice(2));
const scenarioConfig = SCENARIOS[selected.scenario];
const scenarioName = selected.scenario;
const flowName = scenarioConfig.flow;
/* Scopes the per-scenario temp roots in setup.mjs / run-engine.mjs so flows can run in parallel. */
process.env.XFORGE_LIVE_ENGINE_SCENARIO = scenarioName;
await mkdir(resultsRoot, { recursive: true });

/*
 * Replay mode. The cassette stands in for the model and for nothing else — every CLI call, Gate,
 * Approval and commit below runs for real against a freshly installed project. That is what makes a
 * replay a regression test of the tooling rather than a re-enactment of a recording.
 */
const replay = selected.replay ? readCassette(selected.replay) : null;
/* How many times each Stage has been replayed / asserted, so a reworked Flow takes the nth
   recording of its nth visit rather than the first one every time. */
const replayVisits = new Map();
const timelineVisits = new Map();
let cassetteRepo = null;
if (replay) {
  if (replay.scenario !== scenarioName) {
    throw new Error(`Cassette "${replay.scenario}" cannot drive scenario "${scenarioName}".`);
  }
  assertCassetteStillApplies(replay);
  cassetteRepo = path.join(temporaryRoot, `live-engine-${scenarioName}-cassette`);
  rmSync(cassetteRepo, { recursive: true, force: true });
  run('git', ['clone', '--quiet', '--no-checkout', replay.files.bundle, cassetteRepo], repositoryRoot);
}
function cassetteGit(args) {
  return run('git', ['--git-dir', path.join(cassetteRepo, '.git'), ...args], repositoryRoot);
}

/*
 * One entry per Stage the Agent drove, written on a live run and asserted on a replay. The value
 * that matters is `contentRevision`: `core/revision.ts` derives it from the Change's governed
 * content and the policy snapshot, with no commit id or timestamp in it, so identical trees must
 * produce an identical revision. Comparing it after every Stage turns any drift in how content is
 * digested into an immediate, located failure instead of a vague one at archive time.
 */
const timeline = { scenario: scenarioName, flow: flowName, changeId: null, cli: null, outcome: null, reworks: 0, stages: [] };
function timelineStep(projectRoot, stageId) {
  const change = changeState(projectRoot);
  const entry = {
    stage: stageId,
    contentRevision: change.governance?.revision?.contentRevision ?? null,
    currentStage: change.governance?.currentStage ?? null,
  };
  if (!replay) { timeline.stages.push(entry); return; }
  const visit = (timelineVisits.get(stageId) ?? 0);
  timelineVisits.set(stageId, visit + 1);
  const recorded = (replay.stages ?? []).filter((candidate) => candidate.stage === stageId)[visit];
  if (!recorded) return;
  if (recorded.contentRevision !== entry.contentRevision) {
    throw new Error(`Replay diverged at ${stageId}: contentRevision ${entry.contentRevision} does not match the recorded ${recorded.contentRevision}. The same content produced a different revision, so something in how governed content is digested has changed.`);
  }
  /*
   * `currentStage` is recorded but deliberately not asserted. An Agent transitions inside the turn
   * that produced its Artifacts, so the recording observed the Stage it moved to; a replay makes
   * that move a few steps later, from the harness, and would report the Stage it moved from. The
   * difference is one of timing, not of behaviour, and the Stage sequence is already asserted by the
   * loop having to reach each recorded Stage at all. `contentRevision` above carries the weight, and
   * it is independent of where the Change sits.
   */
}

const setup = JSON.parse(run('node', [
  path.join(scriptsRoot, 'setup.mjs'), '--scenario', scenarioName, '--seed', flowName, '--cli-source', selected['cli-source'],
], repositoryRoot));
const projectRoot = setup.project;

const flow = parse(await readFile(path.join(projectRoot, 'xforge', 'flows', `${flowName}.yaml`), 'utf8'));
const stages = flow.stages;
const policyPath = path.join(resultsRoot, `${scenarioName}-policy.json`);
let policy = createLiveEnginePolicy({
  suiteBudgetUsd: Number(selected['suite-budget']),
  maxAttemptsPerStage: Number(selected['max-attempts']),
  timeoutSeconds: Number(selected['timeout-seconds']),
  stages: [
    ...stages.map((stage) => stage.id),
    /* Any Stage can turn out to owe a delivery — whether one does is a fact about the Change the
       Agents write, not about the Flow, which declares nothing on the subject. The budget policy
       rejects a stage id it was not told about up front, so every Stage is declared with its
       continuation turn; the unused ones simply never run. */
    ...stages.map((stage) => `${stage.id}-delivered`),
    ...(scenarioConfig.inject ? [scenarioConfig.inject.stageLabel] : []),
    'archive',
  ],
});
await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

const outlineCheckable = { proposal: 'headings', design: 'headings', assurance: 'headings', 'check-report': 'headings', clarifications: 'headings', 'delta-specs': 'markers' };

const maxReworks = scenarioConfig.maxReworks ?? 0;
/* Bounds oscillation: an Agent that keeps bouncing between two Stages would otherwise burn the
   whole suite budget without ever failing. */
const stepBudget = stages.length + maxReworks * stages.length + 4;
let reworks = 0;
let steps = 0;
let injected = false;
let mutated = false;
const allowedOutcomes = [scenarioConfig.expect?.outcome ?? 'archived'].flat();
let outcome = 'archived';
let stoppedAtCheck = null;
/* The Transition receipt already attributed to a rework, so the next iteration does not count the
   same one again while the Flow sits on the Stage it was sent back to. */
let countedReceipt = null;

for (let index = 0; index < stages.length; ) {
  if (++steps > stepBudget) {
    throw new Error(`Stage loop exceeded ${stepBudget} steps for ${scenarioName}; the Change is oscillating between Stages.`);
  }
  const stage = stages[index];
  const nextStage = stages[index + 1];
  let advanced = true;

  await runEngine({
    projectRoot, scenario: scenarioName, stageId: stage.id,
    promptRelative: path.posix.join(flowName, `${stage.id}.md`), policyPath, options: selected,
  });

  for (const artifactId of stage.produces ?? []) {
    const mode = outlineCheckable[artifactId];
    const artifact = flow.artifacts.find((entry) => entry.id === artifactId);
    if (!artifact || !mode) continue;
    assertArtifactOutline({ projectRoot, flowName, artifactId, file: changePath(scenarioConfig.changeId, artifact.generates), mode });
  }

  commit(projectRoot, `Live engine stage complete: ${scenarioName}:${stage.id}`);
  timelineStep(projectRoot, stage.id);

  /* A harness-planted change to the Change itself, committed on its own so the diff shows exactly
     what the Agent was not responsible for. Runs after the Stage's commit, so the defect lands on
     top of finished work rather than racing the Agent that produced it. */
  if (scenarioConfig.mutate?.afterStage === stage.id && !mutated) {
    mutated = true;
    await scenarioConfig.mutate.apply(projectRoot);
  }

  /*
   * A dispatched work package stays `running` until its delivery evidence exists, and
   * `apply -> verify` is correctly blocked while it does. record-delivery.mjs has always existed
   * for this and was simply never called, so the Agent waited for the harness to record delivery
   * while the harness waited for the Agent to transition.
   *
   * Order matters twice over. This must run before the self-transition check below, which is where
   * the deadlock surfaced — and it must run *after* the Stage commit above, or the Agent's
   * implementation is still uncommitted and the delivery diff contains nothing but the dispatch
   * receipt XForge wrote itself.
   *
   * Which packages owe a delivery is read off the Change, for the same reason dispatch below is: no
   * Flow declares `execution.workPackages`, so the field this was once gated on is never present and
   * this whole block never ran. Gating dispatch on real state while leaving delivery on the dead
   * field just moves the deadlock one step later — a live Solid run dispatched T001 and then blocked
   * on `work-package:T001:running`, with the Agent's turn already over.
   */
  const owed = changeState(projectRoot).workPackages?.packages?.filter((entry) => entry.status === 'running' && !entry.delivery) ?? [];
  if (owed.length > 0) {
    for (const owedPackage of owed) {
      const recorded = spawnSync(process.execPath, [
        path.join(scriptsRoot, 'record-delivery.mjs'), '--root', projectRoot,
        '--change', scenarioConfig.changeId, '--package', owedPackage.id,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (recorded.status !== 0) throw new Error(`Recording work-package delivery failed for ${owedPackage.id}: ${recorded.stderr || recorded.stdout}`);
    }
    commit(projectRoot, `Recorded work package delivery for ${owed.map((entry) => entry.id).join(', ')}`);
    /*
     * The Agent's turn is over by the time the delivery exists, so it never had a legal moment to
     * leave Apply. While it was running, the package was `running` and `apply -> verify` was
     * correctly blocked; the delivery only lands here, one step later. Without a second turn the Stage is
     * deadlocked for a reason that is an artifact of the harness playing Worker, not a governance
     * fact — the harness waits for a transition the Agent was never able to make.
     *
     * A continuation turn is the honest resolution: the Agent observes the delivery it could not
     * see, and performs the transition itself. Transitioning on its behalf would test the CLI and
     * quietly stop testing whether an Agent can drive the Flow, which is the whole point.
     */
    await runEngine({
      projectRoot, scenario: scenarioName, stageId: `${stage.id}-delivered`,
      promptRelative: 'standalone/delivered.md', policyPath, options: selected,
    });
    commit(projectRoot, `Live engine continuation: ${stage.id} delivery observed`);
    timelineStep(projectRoot, `${stage.id}-delivered`);
  }

  if (scenarioConfig.inject?.afterStage === stage.id && !injected) {
    injected = true;
    if (scenarioConfig.inject.beforeInject) await scenarioConfig.inject.beforeInject(projectRoot);
    await runEngine({
      projectRoot, scenario: scenarioName, stageId: scenarioConfig.inject.stageLabel,
      promptRelative: scenarioConfig.inject.prompt, policyPath, options: selected,
    });
    commit(projectRoot, `Live engine standalone checkpoint: ${scenarioConfig.inject.stageLabel}`);
    timelineStep(projectRoot, scenarioConfig.inject.stageLabel);
  }

  if (stage.exit?.approvals?.length) {
    await runApprovals({
      projectRoot, policyIds: stage.exit.approvals, transition: nextStage?.id ?? 'verify', changeId: scenarioConfig.changeId,
    });
    const moved = tryXforgeJson(projectRoot, ['transition', '--change', scenarioConfig.changeId, '--to', nextStage.id]);
    if (moved.ok) {
      commit(projectRoot, `Approved and transitioned into ${nextStage.id}`);
    } else {
      /*
       * A Stage whose Gates hold it back is the model working, not the run failing: a live Major
       * run reached check -> apply with `gate:check-findings:failed` because the Check Agent had
       * recorded an open blocker naming the Stage to go back to. Forcing the Transition here would
       * have thrown away the one path the Flow defines for that finding — and the rework arm below
       * never sees it, because it only recognises a backward move the Agent made itself.
       */
      const target = declaredReworkTarget(projectRoot, moved, stage);
      if (!target) {
        const blocks = moved.diagnostics?.filter((item) => item.severity === 'error').map((item) => item.message).join(' ');
        throw new Error(`Transition ${stage.id} -> ${nextStage.id} was blocked with no declared rework target: ${blocks || 'no error diagnostic'}`);
      }
      reworks += 1;
      if (reworks > maxReworks) {
        /*
         * Out of reworks with a blocker still open. For an adversarial scenario that is the outcome
         * it was built to produce, not a crash: the Flow refused to let implementation start on a
         * Spec that promises what its immutable suite cannot verify, twice. `assertStoppedAtCheck`
         * decides whether the governance chain actually earned that verdict.
         */
        if (allowedOutcomes.includes('stopped-at-check') && stage.id === 'check') {
          outcome = 'stopped-at-check';
          stoppedAtCheck = assertStoppedAtCheck(projectRoot, flow, stage);
          break;
        }
        throw new Error(`${scenarioName} reworked ${reworks} times (limit ${maxReworks}); last was ${stage.id} -> ${target} on a blocking finding.`);
      }
      runXforgeJson(projectRoot, ['transition', '--change', scenarioConfig.changeId, '--to', target]);
      process.stdout.write(`${JSON.stringify({ rework: reworks, from: stage.id, to: target, cause: 'blocking-finding' })}\n`);
      commit(projectRoot, `Reworked ${stage.id} -> ${target} on a blocking finding`);
      countedReceipt = (changeState(projectRoot).governance.transitions ?? []).at(-1)?.digest ?? countedReceipt;
      index = stages.findIndex((candidate) => candidate.id === target);
      await reopenStageAttempts(policyPath, stages.slice(index).map((candidate) => candidate.id));
      continue;
    }
  } else if (nextStage) {
    const current = changeState(projectRoot).governance.currentStage;
    if (current !== nextStage.id) {
      /*
       * The Agent sent the work back, which is what a Stage that found a real problem is supposed
       * to do. Treat it as progress, not failure, and re-drive from the target Stage. Re-traversal
       * re-earns every Gate and Approval on its own: evidence binds to contentRevision and
       * approvals to governingRevision, so any material change made during the rework invalidates
       * what was collected before it.
       *
       * The backward move is judged from the last transition receipt, not from the loop's position.
       * An Agent can move forward and then back inside a single engine call — a live run went
       * propose -> design and the revise checkpoint then sent design -> propose — so the Stage that
       * declared the rework is whatever the receipt says, and it need not be the Stage the loop is
       * driving. Landing back on the current Stage (`target === index`) is a rework too.
       */
      const target = stages.findIndex((candidate) => candidate.id === current);
      const receipts = changeState(projectRoot).governance.transitions ?? [];
      const backward = receipts.at(-1);
      const origin = backward && stages.find((candidate) => candidate.id === backward.from);
      /*
       * One receipt is one rework, however many Stages later it is still the newest one.
       *
       * This branch recognises a rework by the last Transition receipt pointing backwards, which is
       * sound only until the Flow stands still afterwards: the same receipt is then the newest one
       * on the next iteration too, and gets counted again. A replay of Major hit it immediately —
       * the harness performs the rework itself, lands on the target Stage, finds no forward move to
       * attribute, and re-read its own receipt as a second rework. A live run can reach it just as
       * well: `solid-rework` once had Check record its blocker and stop without transitioning.
       */
      const isDeclaredRework = target >= 0 && target <= index
        && Boolean(backward) && backward.to === current
        && (origin?.reworkTo ?? []).includes(current)
        && backward.digest !== countedReceipt;
      /*
       * Standing still is not the same as failing to act. A Stage held by an open blocker is a
       * Change the Flow is refusing to advance, and the Agent that recorded that blocker is right
       * to stop rather than transition — `solid-rework` produced exactly this on its first run:
       * Check found the planted contradiction, wrote `F-1` with `reworkTo: design`, and left the
       * Change where it was, and this branch called that a delinquent Agent.
       *
       * The block is probed with `--dry-run`, so asking the question does not move the Change. An
       * Approval-gated Stage reaches the same conclusion through `declaredReworkTarget` above; this
       * gives the ungated Stages the same reading rather than a second interpretation of it.
       */
      let reworkFrom = backward?.from;
      let reworkTo = current;
      let movedForward = false;
      if (!isDeclaredRework) {
        const probe = tryXforgeJson(projectRoot, ['transition', '--change', scenarioConfig.changeId, '--to', nextStage.id, '--dry-run']);
        /*
         * On a replay there is no Agent to have moved the Change, and the receipt it wrote during
         * the recording is deliberately not restored — receipts chain, and grafting one run's chain
         * onto another's forks it. So the harness makes the move the recording shows the Agent
         * making, once the Gates agree it is allowed. What is being tested here is that the CLI
         * still permits it on this content, not that a model remembered to ask.
         */
        if (replay && probe.data?.ready) {
          runXforgeJson(projectRoot, ['transition', '--change', scenarioConfig.changeId, '--to', nextStage.id]);
          commit(projectRoot, `Replayed the Agent's transition into ${nextStage.id}`);
          movedForward = true;
        } else {
          const held = current === stage.id ? declaredReworkTarget(projectRoot, probe, stage) : null;
          if (!held) {
            const blocks = probe.diagnostics?.filter((item) => item.severity === 'error').map((item) => item.message).join(' ');
            throw new Error(`Agent did not self-transition ${stage.id} -> ${nextStage.id} as instructed (currentStage=${current}, lastReceipt=${backward ? `${backward.from}->${backward.to}` : 'none'})${blocks ? `; the Stage is blocked by: ${blocks}` : ' and nothing blocks it'}.`);
          }
          runXforgeJson(projectRoot, ['transition', '--change', scenarioConfig.changeId, '--to', held]);
          reworkFrom = stage.id;
          reworkTo = held;
        }
      }
      if (!movedForward) {
      reworks += 1;
      if (reworks > maxReworks) {
        /* The same verdict the Approval-gated arm reaches, and reachable from here too: whether a
           Stage's exit is gated decides which branch notices the block, not whether running out of
           reworks at Check is a governance result. Major replays through this arm and was failing on
           an outcome its live run had earned through the other. */
        /* Judged by where the rework came *from*, not by the loop's cursor: an Agent can move
           forward and back inside one turn, so the Stage that declared the rework is the one the
           receipt names, and that is what "ran out of reworks at Check" means. */
        const origin = stages.find((candidate) => candidate.id === reworkFrom) ?? stage;
        if (allowedOutcomes.includes('stopped-at-check') && origin.id === 'check') {
          outcome = 'stopped-at-check';
          stoppedAtCheck = assertStoppedAtCheck(projectRoot, flow, origin);
          break;
        }
        throw new Error(`${scenarioName} reworked ${reworks} times (limit ${maxReworks}); last was ${reworkFrom} -> ${reworkTo} (loop at ${stage.id}).`);
      }
      process.stdout.write(`${JSON.stringify({ rework: reworks, from: reworkFrom, to: reworkTo, cause: isDeclaredRework ? 'agent-transition' : 'blocking-finding' })}\n`);
      commit(projectRoot, `Reworked ${reworkFrom} -> ${reworkTo}`);
      countedReceipt = (changeState(projectRoot).governance.transitions ?? []).at(-1)?.digest ?? countedReceipt;
      index = stages.findIndex((candidate) => candidate.id === reworkTo);
      await reopenStageAttempts(policyPath, stages.slice(index).map((candidate) => candidate.id));
      advanced = false;
      }
    }
  }

  /*
   * Dispatch whatever the Change actually says is undispatched, rather than a hardcoded T001 gated
   * on a Flow field. `core/control-plane.ts` blocks apply -> verify on the existence of a
   * work-package plan and nothing else — no Flow declares a Stage work-package-driven, and the
   * `execution.workPackages` key this once keyed on was never read by the product at all. Keying
   * the harness on a field the product ignores is how a live Solid run reached apply -> verify with
   * a package still `ready` and no dispatch anywhere in its history.
   */
  if (advanced) {
    const entered = changeState(projectRoot);
    /* `commands/work-package.ts` refuses to dispatch outside apply, so this is the product's own
       rule read back rather than a second copy of it kept in step by hand. */
    const ready = entered.governance.currentStage === 'apply' ? entered.workPackages?.ready ?? [] : [];
    for (const packageId of ready) {
      const dispatched = runXforgeJson(projectRoot, ['work-package', 'dispatch', '--change', scenarioConfig.changeId, '--package', packageId]);
      if (!dispatched.ok) throw new Error(`Work-package dispatch failed for ${packageId} after entering ${nextStage?.id ?? 'the next Stage'}.`);
    }
    if (ready.length > 0) commit(projectRoot, `Dispatched work packages ${ready.join(', ')}`);
  }
  if (advanced) index += 1;
}

/*
 * Everything from here to the acceptance run is the archive path, and it only applies when the Flow
 * was meant to reach the end. A scenario that stopped at Check on purpose has no Change left to
 * transition, approve or archive; running these anyway would fail on a Change that is exactly where
 * the governance chain decided it belongs.
 */
if (outcome === 'archived') {
runXforgeJson(projectRoot, ['check', '--change', scenarioConfig.changeId]);
const readyState = runXforgeJson(projectRoot, ['state', '--change', scenarioConfig.changeId]);
if (readyState.data.change.governance.currentStage !== 'ready-to-archive') {
  runXforgeJson(projectRoot, ['transition', '--change', scenarioConfig.changeId, '--to', 'ready-to-archive']);
  commit(projectRoot, 'Transitioned into ready-to-archive');
}

await runApprovals({
  projectRoot, policyIds: flow.terminal.archive.approvals ?? [], transition: 'archive', changeId: scenarioConfig.changeId,
});
runXforgeJson(projectRoot, ['audit', 'verify', '--change', scenarioConfig.changeId]);
runXforgeJson(projectRoot, ['archive', '--change', scenarioConfig.changeId, '--dry-run']);

/*
 * Archive is the Flow's terminal operation, and it was the one step nothing asserted: `passed`
 * below only looked at the acceptance suite and the budget, so a run where the Change never left
 * the active set still reported ok:true. It also cannot be the Agent's job — closing Approvals are
 * externally signed, and an Agent must never hold the provider secret, so `xforge archive`
 * legitimately refuses in the Agent's environment. The authoritative archive therefore runs here,
 * where the secret exists.
 *
 * A Quick run used to drive this step through a `xforge-archive` Skill prompt to prove that shim
 * still delegated to `xforge-verify`. The shim is gone, so the step that was only ever testing the
 * shim goes with it: nothing about the archive transaction itself needed a model in the loop.
 */
const activeAfterAgent = runXforgeJson(projectRoot, ['state']).data.changes ?? [];
if (activeAfterAgent.includes(scenarioConfig.changeId)) {
  runXforgeJson(projectRoot, ['archive', '--change', scenarioConfig.changeId]);
}
commit(projectRoot, 'Archived Change');

const archivedState = runXforgeJson(projectRoot, ['state']);
const stillActive = (archivedState.data.changes ?? []).includes(scenarioConfig.changeId);
const canonicalSpecs = (archivedState.data.specs ?? []).length;
if (stillActive || canonicalSpecs === 0) {
  throw new Error(`Archive did not complete for ${scenarioName}:${scenarioConfig.changeId} (stillActive=${stillActive}, canonicalSpecs=${canonicalSpecs}).`);
}
}

/*
 * The number of reworks is an assertion, not a tolerance. `maxReworks` only ever bounded runaway
 * oscillation, so a scenario built to prove the rework path works passed identically when it never
 * reworked at all -- a live Solid run did exactly that. A scenario that declares the count fails on
 * either side of it: too few means the path was never exercised, too many means it did not land.
 */
const expectedReworks = scenarioConfig.expect?.reworks;
if (expectedReworks !== undefined && reworks !== expectedReworks) {
  throw new Error(`${scenarioName} expected exactly ${expectedReworks} rework(s) and saw ${reworks}.`);
}
if (!allowedOutcomes.includes(outcome)) {
  throw new Error(`${scenarioName} ended as "${outcome}", which is not one of: ${allowedOutcomes.join(', ')}.`);
}

/*
 * The acceptance suite is the archived outcome's proof and only its proof. A Flow that stopped at
 * Check never reached Apply, so there is no implementation for the suite to exercise and its failure
 * would say nothing about the run -- the governance criterion `assertStoppedAtCheck` already applied
 * is what that outcome is judged on.
 */
timeline.changeId = scenarioConfig.changeId;
timeline.outcome = outcome;
timeline.reworks = reworks;
timeline.cli = setup.cli ?? null;
if (!replay) {
  await writeFile(path.join(resultsRoot, `${scenarioName}-timeline.json`), `${JSON.stringify(timeline, null, 2)}\n`);
}

const acceptance = outcome === 'archived'
  ? spawnSync('npm', ['test'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  : null;
const finalPolicy = assertLiveEnginePolicy(JSON.parse(await readFile(policyPath, 'utf8')));
const passed = (acceptance === null || acceptance.status === 0)
  && finalPolicy.budgetAccountingComplete
  && finalPolicy.spentUsd <= finalPolicy.suiteBudgetUsd;

process.stdout.write(`${JSON.stringify({
  ok: passed,
  scenario: scenarioName,
  flow: flowName,
  intent: scenarioConfig.intent ?? null,
  outcome,
  reworks,
  stoppedAtCheck,
  project: projectRoot,
  acceptanceExitCode: acceptance?.status ?? null,
  /* Reported in tokens: the spend figure still gates the run (see `budgetAccountingComplete`,
     which fails the suite when a call's cost could not be accounted for) but it is priced by
     whichever engine served the request, so it is not comparable across runs. */
  suiteTokens: finalPolicy.tokens ?? null,
  budgetAccountingComplete: finalPolicy.budgetAccountingComplete,
  policyPath,
}, null, 2)}\n`);
process.exitCode = passed ? 0 : 1;
