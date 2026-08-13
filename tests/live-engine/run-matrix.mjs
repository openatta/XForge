import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';
import { spawnXforge, runXforgeJson } from './xforge-cli.mjs';
import { assertLiveEnginePolicy, createLiveEnginePolicy } from './policy.mjs';

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

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const scriptsRoot = path.join(repositoryRoot, 'tests', 'live-engine');
const scenariosRoot = path.join(scriptsRoot, 'scenarios');
const temporaryRoot = path.join(repositoryRoot, 'tests', '.tmp');
const resultsRoot = path.join(temporaryRoot, 'live-engine-results');

const SCENARIOS = {
  quick: {
    changeId: 'greeter',
    inject: { afterStage: 'apply', prompt: 'standalone/status.md', stageLabel: 'standalone-status' },
    archiveVia: 'standalone/archive.md',
  },
  solid: {
    changeId: 'task-ledger',
    /* Rework is a legitimate Check outcome, not a failure: the Stage's job is to send work back when
       it finds a real problem. Only Solid drives it, so quick/major stay single-path and remain
       usable as deterministic regression baselines. */
    maxReworks: 2,
    inject: {
      afterStage: 'propose',
      prompt: 'standalone/revise.md',
      stageLabel: 'standalone-revise',
      beforeInject: appendRequirementToTaskLedgerRequest,
    },
  },
  major: {
    changeId: 'credential-store',
    inject: { afterStage: 'check', prompt: 'standalone/continue.md', stageLabel: 'standalone-continue' },
    /* A Check stop with a real, evidence-backed blocker is Major's documented expected outcome
       (README.md: "Major's expected outcome"), not a failure; the loop classifies it below. */
    expectedCheckStop: { stage: 'check' },
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
  if (!SCENARIOS[result.flow]) throw new Error(`--flow must be one of: ${Object.keys(SCENARIOS).join(', ')}`);
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

async function runEngine({ projectRoot, scenario, stageId, promptRelative, policyPath, options: cliOptions }) {
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
  const result = spawnSync(process.execPath, [path.join(scriptsRoot, 'run-engine.mjs'), ...args], {
    encoding: 'utf8', stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`Live engine call failed for ${scenario}:${stageId}. See ${outputPath}.`);
}

/**
 * The budget policy allows `max-attempts` tries per Stage (TEST_DESIGN.md: "每 stage 最多两次
 * 尝试"), but nothing used to drive them — the first engine failure aborted the whole Flow, which
 * is why a transient provider drop used to sink Quick and a machine-sleep timeout used to sink
 * Major. This consumes that allowance. Before spending a paid retry it first asks `recovery`
 * whether the Stage's work actually landed anyway: a run killed by its wall-clock timeout just
 * after finishing (its artifacts and self-transition already on disk) should advance, not re-burn
 * budget re-running a Stage that already delivered.
 */
async function runEngineResilient({ projectRoot, scenario, stageId, promptRelative, policyPath, options: cliOptions, recovery }) {
  const maxAttempts = Number(cliOptions['max-attempts']);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runEngine({ projectRoot, scenario, stageId, promptRelative, policyPath, options: cliOptions });
      return;
    } catch (error) {
      if (recovery && await recovery()) {
        process.stdout.write(`${JSON.stringify({ recovered: scenario, stage: stageId, because: error.message })}\n`);
        return;
      }
      const policy = JSON.parse(await readFile(policyPath, 'utf8'));
      const attemptsUsed = policy.stages?.[stageId]?.attempts ?? 0;
      if (attempt >= maxAttempts || attemptsUsed >= maxAttempts) throw error;
      process.stdout.write(`${JSON.stringify({ retry: scenario, stage: stageId, attempt: attemptsUsed + 1, because: error.message })}\n`);
    }
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

async function pathExists(target) {
  try { await access(target); return true; } catch { return false; }
}

function gateFromBlockedTransition(envelope) {
  const message = (envelope?.diagnostics ?? [])
    .find((entry) => entry.code === 'XFORGE_TRANSITION_BLOCKED')?.message ?? '';
  const match = /gate:([a-z0-9-]+):failed/.exec(message);
  return match ? match[1] : null;
}

/**
 * Validates the deterministic evidence README.md's "Major's expected outcome" demands before a
 * gate-blocked Check exit is classified as a pass instead of a failure:
 *   1. the blocking gate is check-findings;
 *   2. the findings ledger holds at least one open blocker naming a reworkTo Stage, and every
 *      blocker ref resolves to a file that actually exists (line-number suffixes stripped, tried
 *      both change-relative and project-relative) — prose the model wrote alone cannot satisfy
 *      this, a fabricated blocker cites files that are not there;
 *   3. the Stage's exit Approval policy has collected at least `minApprovers` signed receipts.
 * Anything less means the stop is not the designed outcome and the run must fail.
 */
async function validateExpectedCheckStop({ projectRoot, flow, changeId, stage, gate }) {
  const reasons = [];
  const state = runXforgeJson(projectRoot, ['state', '--change', changeId]);
  const changeRoot = path.join(projectRoot, state.data.change.path);
  const ledgerPath = path.join(changeRoot, 'evidence', 'check-findings.yaml');
  if (gate !== 'check-findings') reasons.push(`blocked by unexpected gate ${gate}`);
  if (!await pathExists(ledgerPath)) {
    reasons.push(`no findings ledger at ${ledgerPath}`);
    return { ok: false, reasons, blockers: [], approvals: 0 };
  }
  const ledger = parse(await readFile(ledgerPath, 'utf8'));
  const blockers = (ledger.findings ?? []).filter(
    (entry) => entry.severity === 'blocker' && entry.status === 'open' && entry.reworkTo,
  );
  if (blockers.length === 0) reasons.push('ledger has no open blocker naming a reworkTo Stage');
  for (const blocker of blockers) {
    for (const ref of blocker.refs ?? []) {
      const stripped = ref.replace(/:\d+$/, '');
      const resolved = await pathExists(path.join(changeRoot, stripped))
        || await pathExists(path.join(projectRoot, stripped));
      if (!resolved) reasons.push(`${blocker.id} cites missing file ${ref}`);
    }
  }
  const policyId = (stage.exit?.approvals ?? [])[0];
  const definition = (flow.governance?.approvalPolicies ?? []).find((entry) => entry.id === policyId);
  const approvalsDir = path.join(changeRoot, 'approvals', policyId);
  const receipts = await pathExists(approvalsDir)
    ? (await readdir(approvalsDir)).filter((name) => name.endsWith('.json'))
    : [];
  if (!definition || receipts.length < definition.minApprovers) {
    reasons.push(`approval ${policyId} has ${receipts.length} receipts (minApprovers ${definition?.minApprovers ?? 'unknown'})`);
  }
  return { ok: reasons.length === 0, reasons, blockers, approvals: receipts.length };
}

const selected = options(process.argv.slice(2));
const scenarioConfig = SCENARIOS[selected.flow];
/* Scopes the per-scenario temp roots in setup.mjs / run-engine.mjs so flows can run in parallel. */
process.env.XFORGE_LIVE_ENGINE_SCENARIO = selected.flow;
await mkdir(resultsRoot, { recursive: true });

const setup = JSON.parse(run('node', [
  path.join(scriptsRoot, 'setup.mjs'), '--scenario', selected.flow, '--cli-source', selected['cli-source'],
], repositoryRoot));
const projectRoot = setup.project;

const flow = parse(await readFile(path.join(projectRoot, 'xforge', 'flows', `${selected.flow}.yaml`), 'utf8'));
const stages = flow.stages;
const policyPath = path.join(resultsRoot, `${selected.flow}-policy.json`);
let policy = createLiveEnginePolicy({
  suiteBudgetUsd: Number(selected['suite-budget']),
  maxAttemptsPerStage: Number(selected['max-attempts']),
  timeoutSeconds: Number(selected['timeout-seconds']),
  stages: [
    ...stages.map((stage) => stage.id),
    /* Every execution Stage gets a continuation turn after its delivery is recorded, and the
       budget policy rejects any stage id it was not told about up front. */
    ...stages.filter((stage) => stage.execution && stage.execution.workPackages !== 'internal').map((stage) => `${stage.id}-delivered`),
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
let checkStop = null;

/* Recovery predicate for a failed engine call on a real Stage: if the Change already moved past
   this Stage (a timeout can fire just as the Agent finishes, and its self-transition may be on
   disk), the Stage delivered — advance instead of re-running it. */
function stageAdvancedPast(fromIndex) {
  try {
    const current = runXforgeJson(projectRoot, ['state', '--change', scenarioConfig.changeId])
      .data.change.governance.currentStage;
    if (current === 'ready-to-archive' || current === 'archive') return true;
    return stages.findIndex((candidate) => candidate.id === current) > fromIndex;
  } catch {
    return false;
  }
}

for (let index = 0; index < stages.length; ) {
  if (++steps > stepBudget) {
    throw new Error(`Stage loop exceeded ${stepBudget} steps for ${selected.flow}; the Change is oscillating between Stages.`);
  }
  const stage = stages[index];
  const nextStage = stages[index + 1];
  let advanced = true;

  await runEngineResilient({
    projectRoot, scenario: selected.flow, stageId: stage.id,
    promptRelative: path.posix.join(selected.flow, `${stage.id}.md`), policyPath, options: selected,
    recovery: () => stageAdvancedPast(index),
  });

  for (const artifactId of stage.produces ?? []) {
    const mode = outlineCheckable[artifactId];
    const artifact = flow.artifacts.find((entry) => entry.id === artifactId);
    if (!artifact || !mode) continue;
    assertArtifactOutline({ projectRoot, flowName: selected.flow, artifactId, file: changePath(scenarioConfig.changeId, artifact.generates), mode });
  }

  commit(projectRoot, `Live engine stage complete: ${selected.flow}:${stage.id}`);

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
   */
  if (stage.execution && stage.execution.workPackages !== 'internal') {
    const recorded = spawnSync(process.execPath, [
      path.join(scriptsRoot, 'record-delivery.mjs'), '--root', projectRoot,
      '--change', scenarioConfig.changeId, '--package', 'T001',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (recorded.status !== 0) throw new Error(`Recording work-package delivery failed: ${recorded.stderr || recorded.stdout}`);
    commit(projectRoot, 'Recorded work package T001 delivery');
    /*
     * The Agent's turn is over by the time the delivery exists, so it never had a legal moment to
     * leave Apply. While it was running, T001 was `running` and `apply -> verify` was correctly
     * blocked; the delivery only lands here, one step later. Without a second turn the Stage is
     * deadlocked for a reason that is an artifact of the harness playing Worker, not a governance
     * fact — the harness waits for a transition the Agent was never able to make.
     *
     * A continuation turn is the honest resolution: the Agent observes the delivery it could not
     * see, and performs the transition itself. Transitioning on its behalf would test the CLI and
     * quietly stop testing whether an Agent can drive the Flow, which is the whole point.
     */
    await runEngineResilient({
      projectRoot, scenario: selected.flow, stageId: `${stage.id}-delivered`,
      promptRelative: 'standalone/delivered.md', policyPath, options: selected,
    });
    commit(projectRoot, `Live engine continuation: ${stage.id} delivery observed`);
  }

  if (scenarioConfig.inject?.afterStage === stage.id && !injected) {
    injected = true;
    if (scenarioConfig.inject.beforeInject) await scenarioConfig.inject.beforeInject(projectRoot);
    await runEngineResilient({
      projectRoot, scenario: selected.flow, stageId: scenarioConfig.inject.stageLabel,
      promptRelative: scenarioConfig.inject.prompt, policyPath, options: selected,
    });
    commit(projectRoot, `Live engine standalone checkpoint: ${scenarioConfig.inject.stageLabel}`);
  }

  if (stage.exit?.approvals?.length) {
    await runApprovals({
      projectRoot, policyIds: stage.exit.approvals, transition: nextStage?.id ?? 'verify', changeId: scenarioConfig.changeId,
    });
    /*
     * The forced transition here is the one moment the Flow yaml cannot fully encode: a Stage
     * whose exit is gated can be *legitimately blocked* — Major's documented expected outcome is
     * Check stopping with a real, evidence-backed blocker (README.md: "Major's expected
     * outcome"). Classify that shape instead of throwing, and only when its deterministic
     * evidence validates; any other block (wrong gate, fabricated refs, unsigned exit) is a real
     * failure and reported as one.
     */
    const transitionResult = spawnXforge(projectRoot, ['transition', '--change', scenarioConfig.changeId, '--to', nextStage.id]);
    let transitionEnvelope = null;
    try { transitionEnvelope = JSON.parse(transitionResult.stdout); } catch {}
    if (transitionResult.status !== 0 || !transitionEnvelope?.ok) {
      const gate = gateFromBlockedTransition(transitionEnvelope);
      let verdict = null;
      if (gate && scenarioConfig.expectedCheckStop?.stage === stage.id) {
        verdict = await validateExpectedCheckStop({ projectRoot, flow, changeId: scenarioConfig.changeId, stage, gate });
        if (verdict.ok) {
          checkStop = {
            stage: stage.id, gate,
            blockers: verdict.blockers.map((blocker) => ({ id: blocker.id, reworkTo: blocker.reworkTo, refs: blocker.refs })),
            approvals: verdict.approvals,
          };
          process.stdout.write(`${JSON.stringify({ expectedCheckStop: checkStop })}\n`);
          break;
        }
      }
      throw new Error(`Transition ${stage.id} -> ${nextStage.id} was blocked${gate ? ` (gate:${gate}:failed)` : ''} and is not a valid expected Check stop: ${JSON.stringify(transitionEnvelope?.diagnostics ?? transitionResult.stdout)}${verdict ? ` Evidence gaps: ${verdict.reasons.join('; ')}.` : ''}`);
    }
    commit(projectRoot, `Approved and transitioned into ${nextStage.id}`);
  } else if (nextStage) {
    const current = runXforgeJson(projectRoot, ['state', '--change', scenarioConfig.changeId])
      .data.change.governance.currentStage;
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
      const receipts = runXforgeJson(projectRoot, ['state', '--change', scenarioConfig.changeId])
        .data.change.governance.transitions ?? [];
      const backward = receipts.at(-1);
      const origin = backward && stages.find((candidate) => candidate.id === backward.from);
      const isDeclaredRework = target >= 0 && target <= index
        && Boolean(backward) && backward.to === current
        && (origin?.reworkTo ?? []).includes(current);
      if (!isDeclaredRework) {
        throw new Error(`Agent did not self-transition ${stage.id} -> ${nextStage.id} as instructed (currentStage=${current}, lastReceipt=${backward ? `${backward.from}->${backward.to}` : 'none'}).`);
      }
      reworks += 1;
      if (reworks > maxReworks) {
        throw new Error(`${selected.flow} reworked ${reworks} times (limit ${maxReworks}); last was ${backward.from} -> ${current}.`);
      }
      process.stdout.write(`${JSON.stringify({ rework: reworks, from: backward.from, to: current, receipt: backward.digest })}\n`);
      commit(projectRoot, `Reworked ${backward.from} -> ${current}`);
      index = target;
      advanced = false;
    }
  }

  if (advanced && nextStage?.execution && nextStage.execution.workPackages !== 'internal') {
    const dispatched = runXforgeJson(projectRoot, ['work-package', 'dispatch', '--change', scenarioConfig.changeId, '--package', 'T001']);
    if (!dispatched.ok) throw new Error('Work-package dispatch failed after transitioning into Apply.');
    commit(projectRoot, 'Dispatched work package T001');
  }
  if (advanced) index += 1;
}

let finalPolicy;
if (checkStop) {
  /* Major's documented expected outcome: the governance chain ran to completion and Check
     stopped implementation with a real, evidence-backed blocker. No archive, no acceptance run —
     the Change is still active by design — so pass/fail rests on the budget accounting alone. */
  finalPolicy = assertLiveEnginePolicy(JSON.parse(await readFile(policyPath, 'utf8')));
  const passed = finalPolicy.budgetAccountingComplete && finalPolicy.spentUsd <= finalPolicy.suiteBudgetUsd;
  process.stdout.write(`${JSON.stringify({
    ok: passed,
    flow: selected.flow,
    project: projectRoot,
    outcome: 'expected-check-stop',
    stage: checkStop.stage,
    gate: checkStop.gate,
    blockers: checkStop.blockers,
    approvalReceipts: checkStop.approvals,
    suiteSpentUsd: finalPolicy.spentUsd,
    suiteBudgetUsd: finalPolicy.suiteBudgetUsd,
    budgetAccountingComplete: finalPolicy.budgetAccountingComplete,
    policyPath,
  }, null, 2)}\n`);
  process.exitCode = passed ? 0 : 1;
} else {
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

if (scenarioConfig.archiveVia) {
  await runEngineResilient({
    projectRoot, scenario: selected.flow, stageId: 'archive', promptRelative: scenarioConfig.archiveVia, policyPath, options: selected,
  });
}
/*
 * Archive is the Flow's terminal operation, and it was the one step nothing asserted: `passed`
 * below only looked at the acceptance suite and the budget, so a run where the Change never left
 * the active set still reported ok:true. It also cannot always be the Agent's job — closing
 * Approvals are externally signed, and an Agent must never hold the provider secret, so
 * `xforge archive` legitimately refuses in the Agent's environment. The standalone prompt still
 * exercises the archive Skill and must surface that block honestly; the authoritative archive then
 * runs here, where the secret exists.
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
  throw new Error(`Archive did not complete for ${selected.flow}:${scenarioConfig.changeId} (stillActive=${stillActive}, canonicalSpecs=${canonicalSpecs}).`);
}

const acceptance = spawnSync('npm', ['test'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
finalPolicy = assertLiveEnginePolicy(JSON.parse(await readFile(policyPath, 'utf8')));
const passed = acceptance.status === 0
  && finalPolicy.budgetAccountingComplete
  && finalPolicy.spentUsd <= finalPolicy.suiteBudgetUsd;

process.stdout.write(`${JSON.stringify({
  ok: passed,
  flow: selected.flow,
  project: projectRoot,
  acceptanceExitCode: acceptance.status,
  suiteSpentUsd: finalPolicy.spentUsd,
  suiteBudgetUsd: finalPolicy.suiteBudgetUsd,
  budgetAccountingComplete: finalPolicy.budgetAccountingComplete,
  policyPath,
}, null, 2)}\n`);
process.exitCode = passed ? 0 : 1;
}
