import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from '../../xforge/node_modules/yaml/dist/index.js';
import { spawnXforge, runXforgeJson, tryXforgeJson } from './xforge-cli.mjs';
import { assertLiveEnginePolicy, createLiveEnginePolicy, resetLiveEngineStageAttempts, timeoutScaleForLatency } from './policy.mjs';
import { stoppedAwaitingDeclaration as stoppedAwaitingDeclarationHere } from './outcome.mjs';
import { SCENARIO_IDS } from './scenario-catalogue.mjs';

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
  /*
   * The same Flow and acceptance oracle as `quick`, on a project that is genuinely not a Node one:
   * a `pyproject.toml`, a stdlib `unittest` suite, and no `package.json` anywhere. This shape was
   * impossible to build here until the CLI install moved out of the project, which is exactly why
   * the shipped npm Gates could report `passed` having asserted nothing without any run noticing.
   *
   * The suggestion the CLI offers is deliberately wrong: `pyproject.toml` makes it propose
   * `pytest`, which this project neither uses nor has installed. Declaring what `TEST_REQUEST.md`
   * actually states is the only way through, so a run that adopts the suggestion fails on its own
   * acceptance rather than on a harness assertion.
   */
  'quick-python': {
    flow: 'quick',
    seed: 'quick-python',
    prompts: 'quick-python',
    changeId: 'greeter',
    intent: 'happy-path',
    expect: { reworks: 0, outcome: 'archived' },
  },
  /*
   * The `quick` project with the answer taken away: `TEST_REQUEST.md` does not say how it runs its
   * tests, and there is no human at the terminal to ask. Stopping is the pass.
   *
   * The trap is sharper than it looks. `package.json` is present, so the CLI suggests `npm test` —
   * and here that suggestion is *correct*. Taking it still fails: a suggestion is the start of a
   * question to a person, and a rule that only holds when the guess is wrong is not a rule. This is
   * what `assertStoppedAwaitingDeclaration` checks, by refusing any recorded declaration at all.
   */
  'quick-undeclared': {
    flow: 'quick',
    seed: 'quick-undeclared',
    prompts: 'quick-undeclared',
    changeId: 'greeter',
    intent: 'fail-closed',
    expect: { reworks: 0, outcome: 'stopped-awaiting-declaration' },
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

  /*
   * The same Flow and the same acceptance suite as `major`, given only what a real user would give.
   *
   * `major`'s own TEST_REQUEST.md names the Flow, the Change id, the material question Clarify is
   * supposed to discover, the sections Design must cover, and the whole work-package plan down to
   * `write_paths`. Its Stage prompts carry more of the same. Every one of those was added to repair
   * a live-run failure, and each repaired it by telling the model the answer -- so the harness
   * stopped being able to find that class of failure while real users, holding no such prompt, kept
   * walking into it. A `major` run costs seventeen dollars and proves that a guided model can be
   * guided.
   *
   * This scenario is the control. `intent.md` states functional requirements and the risk, nothing
   * else; the Stage prompts carry environment constraints and "read AGENTS.md" and nothing else.
   * `check-vocabulary.mjs` fails the build if either ever acquires product vocabulary again.
   *
   * It seeds from `major` so the immutable acceptance suite cannot drift between the two, then
   * replaces the request. Its outcome is deliberately unconstrained: this tier exists to find out
   * what a real user hits, and a tier that must pass is a tier somebody will make pass.
   */
  'major-cold': {
    flow: 'major',
    seed: 'major',
    prompts: 'major-cold',
    /* Deliberately unset: naming the Change is one of the decisions this tier exists to watch the
       model make, so the runner discovers it instead. */
    changeId: null,
    intent: 'cold',
    maxReworks: 2,
    expect: { outcome: ['archived', 'stopped-at-check', 'stopped-awaiting-declaration'] },
    prepare: replaceRequestWithColdIntent,
  },

  /*
   * Standalone Skills: one prepared project, one model call, one assertion.
   *
   * These four had prompts, coverage-matrix entries, and no runner row, so `check-coverage.mjs`
   * certified them as covered while they had never executed. A Skill no Flow Stage names cannot be
   * reached by the Stage walk at all, so without an entry here it is coverage on paper only.
   *
   * Each `assert` checks the Skill's *observable effect*, never its prose. What the Agent wrote in
   * its final message is not evidence; what it left on disk is.
   */
  'standalone-scaffold': {
    standalone: true,
    seed: 'standalone',
    prompt: 'standalone/scaffold.md',
    intent: 'authoring',
    /* The prompt asks for a project-owned Rule, registered in the Manifest so it projects. Both
       halves are checked: a Rule file nobody selected changes nothing, and a selection naming a
       file that does not exist breaks install. */
    assert: async (projectRoot) => {
      const rulePath = path.join(projectRoot, 'xforge', 'scaffold', 'rules', 'no-console-log.yaml');
      const manifest = parse(await readFile(path.join(projectRoot, 'xforge', 'manifest.yaml'), 'utf8'));
      const selectedRules = manifest.scaffold?.rules ?? [];
      return [
        { name: 'rule-file-written', ok: existsSync(rulePath), detail: 'xforge/scaffold/rules/no-console-log.yaml' },
        { name: 'rule-registered-in-manifest', ok: selectedRules.includes('no-console-log'), detail: `scaffold.rules = ${JSON.stringify(selectedRules)}` },
      ];
    },
  },
  'standalone-architect': {
    standalone: true,
    seed: 'standalone',
    prompt: 'standalone/architect.md',
    intent: 'authoring',
    /* The Skill's whole point is that a project with no architecture file is not in violation: it
       writes one by questioning, and says the absence blocked nothing. */
    assert: async (projectRoot) => {
      const architecturePath = path.join(projectRoot, 'xforge', 'architecture.md');
      const written = existsSync(architecturePath) ? await readFile(architecturePath, 'utf8') : '';
      return [
        { name: 'architecture-written', ok: written.trim().length > 0, detail: 'xforge/architecture.md' },
        { name: 'has-sections', ok: /^##\s/m.test(written), detail: 'at least one ## section' },
      ];
    },
  },
  'standalone-kanban': {
    standalone: true,
    seed: 'standalone',
    prompt: 'standalone/kanban.md',
    intent: 'read-only',
    /*
     * Read-only by contract, so the assertion is inverted: what matters is that it reported without
     * writing governance state. A Skill that surveys a portfolio and quietly edits it is the defect.
     */
    assert: async (projectRoot) => {
      const status = run('git', ['status', '--porcelain'], projectRoot).trim();
      const touchedGovernance = status.split('\n').filter(Boolean)
        .map((line) => line.slice(3))
        .filter((file) => file.startsWith('xforge/changes/') || file.startsWith('xforge/manifest.yaml') || file.startsWith('xforge/lock.yaml'));
      return [
        { name: 'no-governance-writes', ok: touchedGovernance.length === 0, detail: touchedGovernance.join(', ') || 'clean' },
      ];
    },
  },
  'standalone-upgrade-scaffold': {
    standalone: true,
    seed: 'standalone',
    prompt: 'standalone/upgrade-scaffold.md',
    intent: 'merge',
    /*
     * The one scenario needing a prepared past: a project on an older Scaffold, carrying a Gate a
     * person adapted, with an upgrade already staged. The merge has to keep this project's real test
     * command while adopting what the release changed — taking the incoming file wholesale is the
     * failure, however tidy it looks.
     */
    prepare: async (projectRoot) => {
      const gateRelative = path.join('xforge', 'scaffold', 'gates', 'unit-tests.yaml');
      const gatePath = path.join(projectRoot, gateRelative);
      const adapted = [
        '# Adapted by this project: the placeholder XForge shipped never ran anything here.',
        'apiVersion: xforge.dev/v1alpha1',
        'kind: Gate',
        'metadata:',
        '  name: unit-tests',
        '  version: 2',
        'spec:',
        '  required: true',
        `  command: ${JSON.stringify(PROJECT_ADAPTED_TEST_COMMAND)}`,
        '  shell: false',
        '  workingDirectory: .',
        '  timeoutSeconds: 900',
        '  evidence: tests.json',
        '',
      ].join('\n');
      await writeFile(gatePath, adapted);
      /*
       * Age the Manifest's Scaffold pin so this is a genuine upgrade rather than a no-op, and leave
       * the CLI pin current — that split is exactly the state `xforge update` now leaves behind, and
       * the state a project sits in while a merge is outstanding.
       *
       * Re-stringified rather than patched line-by-line: this is a fixture the harness owns, so
       * losing the shipped comments costs nothing, and a regex over YAML that has to find the right
       * `version:` among three of them is the kind of fragility a test fixture should not carry.
       */
      const manifestPath = path.join(projectRoot, 'xforge', 'manifest.yaml');
      const manifest = parse(await readFile(manifestPath, 'utf8'));
      manifest.scaffold.version = AGED_SCAFFOLD_VERSION;
      manifest.scaffold.source.version = AGED_SCAFFOLD_VERSION;
      await writeFile(manifestPath, stringify(manifest));

      /*
       * Age a Flow too, because a Flow is the asset this whole exercise is about.
       *
       * The fixture used to age only the Scaffold, so `xforge/flows/` arrived byte-identical and
       * the merge never had to touch one -- the run proved the layout did not break and proved
       * nothing about the case it exists for. This drifts Solid the way a real project drifts:
       * behind on version, and carrying a governance choice of its own. Adopting the shipped Flow
       * wholesale would silently drop that choice, which is exactly the failure the Skill is told
       * to refuse.
       */
      const flowPath = path.join(projectRoot, 'xforge', 'flows', 'solid.yaml');
      const flow = parse(await readFile(flowPath, 'utf8'));
      flow.metadata.version = 1;
      for (const policy of flow.governance?.approvalPolicies ?? []) policy.minApprovers = 2;
      await writeFile(flowPath, stringify(flow));

      commit(projectRoot, 'Project adapted the unit-tests Gate and chose two approvers for Solid');
      /* Stage the upgrade the Skill is asked to complete. */
      const staged = spawnXforge(projectRoot, ['upgrade-scaffold']);
      if (staged.status !== 0) throw new Error(`Could not stage an upgrade for ${'standalone-upgrade-scaffold'}: ${staged.stderr || staged.stdout}`);
      commit(projectRoot, 'Staged a Scaffold upgrade for the merge exercise');
    },
    assert: async (projectRoot) => {
      /*
       * Where the project's command has to survive, not which file it has to survive in.
       *
       * This used to grep the merged Gate for the command text, which was right while a Gate carried
       * its own `command:`. The shipped Gate reached `builtin: declared` and reads whatever the
       * project declared under `manifest.verification.<gate>` instead, so a v4 Gate has no `command:`
       * to find -- and the assertion could no longer pass for *any* correct merge. A live run then
       * reported red against a merge that had adopted the new mechanism and migrated the command
       * across with `xforge verification declare`, which is exactly the outcome the scenario wants.
       *
       * So the check follows the fact rather than the file: the command survives if the merged Gate
       * still runs it directly, or if the Manifest declares it for the Gate that now reads it from
       * there. Losing it in both places is the failure this exists to catch, and still fails.
       */
      const gatePath = path.join(projectRoot, 'xforge', 'scaffold', 'gates', 'unit-tests.yaml');
      const merged = existsSync(gatePath) ? await readFile(gatePath, 'utf8') : '';
      const manifestAfter = parse(await readFile(path.join(projectRoot, 'xforge', 'manifest.yaml'), 'utf8'));
      const declaredCommands = (manifestAfter?.verification?.['unit-tests'] ?? [])
        .map((entry) => (entry?.command ?? []).join(' '));
      const wanted = PROJECT_ADAPTED_TEST_COMMAND.join(' ');
      const commandSurvives = merged.includes(PROJECT_ADAPTED_TEST_COMMAND[0]) || declaredCommands.includes(wanted);
      const commandDetail = declaredCommands.length > 0
        ? `Gate declares ${JSON.stringify(declaredCommands)}`
        : 'the Gate carries no command and the Manifest declares none';
      /* The Flow half: a governance choice this project made must not be adopted away. */
      const solidPath = path.join(projectRoot, 'xforge', 'flows', 'solid.yaml');
      const solid = existsSync(solidPath) ? parse(await readFile(solidPath, 'utf8')) : null;
      const approverCounts = (solid?.governance?.approvalPolicies ?? []).map((policy) => policy.minApprovers);
      /*
       * What "finished" looks like after the working state moved into `xforge/.upgrade/`.
       *
       * This used to scan `xforge/` for a `scaffold-<version>` directory. That name no longer exists
       * in any layout this CLI writes, so the check would have passed on every run including one
       * where the Skill never ran `--complete` at all — a green assertion that could no longer fail
       * is worse than no assertion. Two facts now stand in for it: the staged release is gone, and
       * the marker every other command reads is gone with it.
       */
      const incomingLeft = existsSync(path.join(projectRoot, 'xforge', '.upgrade', 'incoming'));
      const markerLeft = existsSync(path.join(projectRoot, 'xforge', 'UPGRADING.md'));
      /* And the half `--complete` now does on the Skill's behalf: the targets render the merged
         Scaffold without anybody running `xforge install`. */
      const projected = path.join(projectRoot, '.claude', 'skills', 'xforge-upgrade-scaffold', 'SKILL.md');
      const projectedSkill = existsSync(projected) ? await readFile(projected, 'utf8') : '';
      return [
        /* The whole point: the project's own command survived a merge that also adopted the release. */
        { name: 'kept-project-command', ok: commandSurvives, detail: commandSurvives ? commandDetail : `expected ${wanted} to survive in the Gate or in manifest.verification; ${commandDetail}` },
        /*
         * A Flow states how many approvals a Stage needs. This project chose two; the shipped Flow
         * asks for one. Adopting the incoming file wholesale would drop that choice without anyone
         * deciding to, which is the failure the merge is told to refuse -- and the exact shape of
         * the drift a real team reported after running an entire Major on a Flow nobody had
         * compared.
         */
        { name: 'kept-project-governance', ok: approverCounts.length > 0 && approverCounts.every((count) => count === 2), detail: `minApprovers ${JSON.stringify(approverCounts)}, expected every policy to stay at 2` },
        { name: 'upgrade-completed', ok: !incomingLeft && !markerLeft, detail: [incomingLeft ? 'xforge/.upgrade/incoming still present' : null, markerLeft ? 'xforge/UPGRADING.md still present' : null].filter(Boolean).join(', ') || 'staged release and in-flight marker both cleared' },
        { name: 'reprojected-without-install', ok: projectedSkill.includes('.upgrade/'), detail: projectedSkill ? 'projected Skill names the merged layout' : 'no projected xforge-upgrade-scaffold SKILL.md' },
      ];
    },
  },
};

/** The command the `standalone-upgrade-scaffold` project "already had", which its merge must keep. */
const PROJECT_ADAPTED_TEST_COMMAND = ['node', '--test', 'test/'];
/** Old enough to make the staged merge a real one; the exact number does not matter, only that it lags. */
const AGED_SCAFFOLD_VERSION = '0.7.12';

const OPTION_DEFAULTS = { 'cli-source': 'npm', 'suite-budget': '30', budget: '3', 'max-attempts': '2', 'timeout-seconds': '900' };

/**
 * A trivial round trip to the configured provider, in milliseconds, or `null` if it cannot be made.
 *
 * The per-stage timeout is a bet on how fast the provider is, and until now it was a fixed one. That
 * bet lost on a real endpoint: `major`'s check stage runs 49 turns, and at the ~7s per turn this
 * project's configured gateway actually delivers, the API time alone is 5.8 minutes — so a 900s
 * ceiling could not survive one slow turn or one retry, and the stage was killed twice at exactly
 * 900s with the run reporting nothing. Ninety-five percent of a stage's wall clock is time spent
 * waiting on this endpoint, so measuring it once is the cheapest possible way to size the ceiling.
 *
 * Deliberately measured rather than configured: an operator who knows better passes
 * `--timeout-seconds` and is never second-guessed (see `explicit` above). This only replaces a
 * default that was calibrated against a provider this run may not be using.
 */
async function probeProviderLatency() {
  try {
    const source = await readFile(path.join(repositoryRoot, '.env'), 'utf8');
    const config = {};
    for (const raw of source.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      config[match[1]] = value;
    }
    if (!config.ANTHROPIC_AUTH_TOKEN || !config.ANTHROPIC_BASE_URL) return null;
    const started = Date.now();
    const response = await fetch(`${config.ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.ANTHROPIC_AUTH_TOKEN, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514', max_tokens: 8, messages: [{ role: 'user', content: 'ok' }] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    await response.text();
    return Date.now() - started;
  } catch { return null; }
}

const PROBE_TIMEOUT_MS = 60_000;

/*
 * The catalogue and this table must name the same scenarios.
 *
 * `check-coverage.mjs` answers "is this Skill covered" from the catalogue, so a catalogue entry with
 * no row here would let it certify a scenario that cannot run — which is precisely the failure that
 * made the catalogue necessary. Refusing at startup keeps the two honest in both directions: a
 * scenario added here and not there is invisible to coverage, and one added there and not here is a
 * claim nothing can satisfy.
 */
function assertCatalogueMatchesTable() {
  const declared = [...SCENARIO_IDS].sort();
  const implemented = Object.keys(SCENARIOS).sort();
  const missing = declared.filter((id) => !implemented.includes(id));
  const extra = implemented.filter((id) => !declared.includes(id));
  if (missing.length === 0 && extra.length === 0) return;
  throw new Error([
    'scenario-catalogue.mjs and run-matrix.mjs disagree about which scenarios exist.',
    missing.length ? `  Catalogued but not implemented here: ${missing.join(', ')}` : null,
    extra.length ? `  Implemented here but not catalogued: ${extra.join(', ')}` : null,
    '  Coverage is answered from the catalogue, so a catalogued scenario with no runner row is coverage nobody can run.',
  ].filter(Boolean).join('\n'));
}

function options(argv) {
  const result = { ...OPTION_DEFAULTS };
  /* Which limits the caller actually stated. An explicit value is a decision and is never scaled;
     a default is a guess this file is entitled to correct once it has measured the provider. */
  const explicit = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Expected key/value options.');
    result[key.slice(2)] = value;
    explicit.add(key.slice(2));
  }
  result.explicit = explicit;
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

/** The argv this project declared for a `builtin: declared` Gate, or null when it declared none. */
function declaredVerification(projectRoot, gate) {
  try {
    const manifest = parse(readFileSync(path.join(projectRoot, 'xforge', 'manifest.yaml'), 'utf8'));
    const entry = (manifest?.verification?.[gate] ?? []).find((item) => Array.isArray(item?.command));
    return entry?.command ?? null;
  } catch { return null; }
}

/**
 * The repository commit this run exercised, and whether it was exercised cleanly.
 *
 * Every result already carried its cost, its token count and the limits it ran under, and none of
 * them said *which build* produced it. So a run could validate one commit while the release tag
 * pointed at another, and nothing in the artefact would show it. That is not hypothetical: three
 * Flow scenarios validated one commit, a feature landed afterwards, the tag moved to include it,
 * and the only thing between that and a publish was somebody noticing.
 *
 * `dirty` carries as much weight as the hash. A run against uncommitted work is not a run against
 * any commit at all, and reporting HEAD alone would claim otherwise.
 */
function testedBuild() {
  try {
    const head = run('git', ['rev-parse', 'HEAD'], repositoryRoot).trim();
    const status = run('git', ['status', '--porcelain'], repositoryRoot).trim();
    return { commit: head, dirty: status.length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
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
  const ledger = path.join(projectRoot, changePath(changeId, 'evidence/check-findings.yaml'));
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
/**
 * The Change this run is about, which is not always something the scenario gets to decide.
 *
 * A guided scenario pins it, because its request names it ("Change ID 固定为 credential-store").
 * A cold scenario cannot: naming the id is one of the answers it exists to make the model find, so
 * `intent.md` says nothing about it and the model picks its own. The first cold run picked
 * `credential-store-cli` and every path built from the pinned id pointed at a directory that did
 * not exist -- the outline check read the absent file and failed the run one Stage in, reporting an
 * empty string because there was nothing there to report on.
 *
 * So the id is discovered rather than declared, from the same portfolio view a person would read.
 */
let changeId = null;

function resolveChangeId(projectRoot) {
  if (changeId) return changeId;
  const portfolio = tryXforgeJson(projectRoot, ['state']);
  const active = portfolio?.data?.activeChanges ?? [];
  if (active.length === 1) {
    changeId = active[0].id;
    process.stdout.write(`${JSON.stringify({ resolvedChangeId: changeId })}\n`);
    return changeId;
  }
  /* Zero is "the Stage produced no Change", many is "this harness cannot tell which is yours".
     Both are real failures, and both used to surface as a path that happened not to exist. */
  throw new Error(active.length === 0
    ? 'No un-archived Change exists after the Stage that should have created one.'
    : `This run owns no single Change: ${active.map((entry) => entry.id).join(', ')}.`);
}

function changeState(projectRoot) {
  /* Reaching here without an id means a caller ran before `resolveChangeId`. Say that, rather than
     passing `null` to the CLI and reporting whatever it makes of it. */
  if (!changeId) throw new Error('changeState was called before the run resolved which Change it owns.');
  /*
   * `--include transitions`, because this harness reads the receipt *chain*.
   *
   * `76fbf49` stopped `state` from re-sending the whole chain on every call — it now reports
   * `{count, route, latest}` and returns the receipts themselves only when asked. Three sites here
   * call `.at(-1)` on `governance.transitions`, which had silently become an object: the first live
   * Major run after that change died at its first rework with `.at is not a function`, having
   * already walked propose → clarify → design → check. Nothing caught it in between because nothing
   * had run this harness since.
   *
   * Asked for by name rather than read from `latest`, so the rework accounting keeps working against
   * the chain it was written for, and a future trim of `latest` cannot quietly change what it means.
   */
  return tryXforgeJson(projectRoot, ['state', '--change', changeId, '--include', 'transitions']).data.change;
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
    /*
     * Two conditions, because the policy's own counter is not always the one that moves.
     *
     * This loop is unbounded and delegated its termination entirely to `policy.stages[stageId]
     * .attempts`. When `run-engine.mjs` refuses to reserve a further attempt it exits non-zero
     * *without* recording one, so that counter stops advancing while the classification stays
     * transient — and the loop spins. A live run reached retry 25,488 on an injected stage before
     * anyone looked. It cost almost nothing (the refused attempts never reach the model, which is
     * why nothing flagged it), but it never ends on its own and the run never fails either.
     *
     * `attempt` is this loop's own count and always advances, so it bounds the loop whatever the
     * policy does. The policy remains the authority on how many attempts are *granted*; this is
     * only the guarantee that asking is finite.
     */
    const grantedExhausted = (policy.stages?.[stageId]?.attempts ?? attempt) >= policy.maxAttemptsPerStage;
    const exhausted = grantedExhausted || attempt >= policy.maxAttemptsPerStage;
    if (!transient.has(classification) || exhausted) {
      throw new Error(`Live engine call failed for ${scenario}:${stageId} (${classification ?? 'unclassified'}, attempt ${attempt}). See ${outputPath}.`);
    }
    process.stdout.write(`${JSON.stringify({ retry: attempt + 1, stage: stageId, cause: classification })}\n`);
  }
}

/**
 * Outline deviations a cold run produced, recorded rather than thrown.
 *
 * A cold run has no verdict to protect -- its outcome is unconstrained on purpose -- so an
 * assertion that aborts it destroys the observation it exists to collect.
 */
const outlineObservations = [];

/**
 * Compares a produced Artifact against its Flow's outline, and decides what a deviation means here.
 *
 * A guided run is told the outline is exact ("no extra section, none omitted"), so any deviation is
 * that run failing to follow its instructions, and it fails.
 *
 * A cold run is told nothing, and the first one measured what that produces: every declared section
 * present in both Artifacts it wrote -- 6 of 6 in the proposal, 8 of 8 in the design -- plus one
 * heading the outline does not list, `## Coverage and next action`. `missing` was empty both times.
 * Killing a six-dollar run over an extra heading that carries real content is the harness enforcing
 * something the product deliberately does not: `validator: outline` reports omission only, on the
 * reasoning that an extra section is usually more information and that demanding exact equality
 * pushes an author to bury content under a heading that does not fit it. That reasoning was an
 * argument when it was written; this is the measurement.
 *
 * So `extra` is an observation in a cold run and `missing` remains a failure in any run -- a
 * declared section that is absent breaks whatever is keyed to it, which is the case for enforcing
 * anything here at all.
 */
function assertArtifactOutline({ projectRoot, flowName, artifactId, file, mode, strict = true }) {
  const args = ['--root', projectRoot, '--flow', flowName, '--artifact', artifactId, '--file', file];
  if (mode) args.push('--mode', mode);
  const result = spawnSync(process.execPath, [path.join(scriptsRoot, 'assert-artifact-outline.mjs'), ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  const unreadable = result.status !== 0 && !json;
  if (!unreadable && !json?.ok && !strict && (json.missing ?? []).length === 0) {
    outlineObservations.push({ artifact: artifactId, file, extra: json.extra ?? [] });
    process.stdout.write(`${JSON.stringify({ outlineObservation: artifactId, extra: json.extra ?? [] })}\n`);
    return json;
  }
  if (unreadable || !json?.ok) {
    throw new Error(`Outline check failed for ${flowName}:${artifactId} (${file}): ${JSON.stringify(json ?? result.stdout)}`);
  }
  return json;
}

/**
 * Swaps the guided request for the cold one, after seeding from `major`.
 *
 * Seeding rather than copying keeps `test/**` -- the immutable acceptance suite both scenarios are
 * measured by -- in exactly one place. Only the request differs, which is the whole variable under
 * test.
 */
async function replaceRequestWithColdIntent(projectRoot) {
  const intentPath = path.join(scenariosRoot, 'major-cold', 'intent.md');
  await writeFile(path.join(projectRoot, 'TEST_REQUEST.md'), await readFile(intentPath, 'utf8'));
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
  const target = path.join(projectRoot, changePath(changeId, generates));
  if (!generates.includes('*')) return existsSync(target);
  const root = path.join(projectRoot, changePath(changeId, generates.split('*')[0]));
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
 *     receipts as `minApprovers` demands, each from a role and a provider the policy admits. This
 *     is what proves the enterprise path ran rather than being quietly skipped.
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
    const directory = path.join(projectRoot, changePath(changeId, path.posix.join('approvals', policyId)));
    let receipts = [];
    try {
      receipts = readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')))
        .filter((receipt) => receipt.decision === 'approve');
    } catch { /* directory missing is reported by the emptiness check below */ }
    const policy = (flowDefinition.governance?.approvalPolicies ?? []).find((entry) => entry.id === policyId);
    const required = policy?.minApprovers ?? 1;
    if (receipts.length < required) problems.push(`${policyId} holds ${receipts.length} approval receipts, needs ${required}.`);
    /*
     * `roles` is an eligibility filter, and that is the only thing it can be checked as here.
     *
     * This used to assert that `separationOfDuties` implies as many *distinct* roles as approvers,
     * which is the exact rule the CLI removed: `separationOfDuties` has never compared roles, it
     * requires that the approver is not an implementer of this Change (`core/revision.ts`'s
     * `changeImplementers`, and the rationale on `flows/major.yaml`'s `approvalPolicies`). Counting
     * distinct roles let a Change's own author approve it and rejected two different maintainers —
     * the commonest real review shape. The assertion sat here inert only because the shipped Major
     * policies ask for one approver, so `roles.size < 1` is never true; at `minApprovers: 2` this
     * harness would have failed runs the product considers correct.
     *
     * Re-deriving the implementer set here would reimplement the rule the CLI already enforces when
     * it accepts a receipt, and a harness that reimplements the thing under test cannot disagree
     * with it usefully. What is worth checking is what the round-trip is supposed to have produced:
     * enough approvals, each from an eligible role and a provider this policy allows.
     */
    for (const receipt of receipts) {
      const role = receipt.approver?.role;
      const provider = receipt.approver?.provider;
      if (policy?.roles?.length && !policy.roles.includes(role)) {
        problems.push(`${policyId} holds a receipt from role ${role ?? 'none'}, which its roles filter (${policy.roles.join(', ')}) does not admit.`);
      }
      if (policy?.providers?.length && provider && !policy.providers.includes(provider)) {
        problems.push(`${policyId} holds a receipt from provider ${provider}, which it does not allow (${policy.providers.join(', ')}).`);
      }
    }
  }

  const ledgerPath = path.join(projectRoot, changePath(changeId, 'evidence/check-findings.yaml'));
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
      const asChange = path.join(projectRoot, changePath(changeId, ref));
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
 * Decides whether a run that stopped for want of a verification command actually earned it.
 *
 * The failure this guards against is not "the Agent could not finish" — it is "the Agent finished
 * by making something up". A Gate with nothing declared refuses, and the correct response is to
 * report what a person has to answer. Recording a command nobody supplied is the wrong response
 * *even when the command is right*: the scenario deliberately leaves enough context lying around to
 * infer a plausible one, so a run that guesses correctly has still demonstrated the behaviour that
 * put an empty Gate into production in the first place.
 */
function assertStoppedAwaitingDeclaration(projectRoot, stage, moved) {
  const problems = [];
  const blocks = (moved.diagnostics ?? []).map((item) => `${item.code}: ${item.message}`).join('\n');

  const manifestPath = path.join(projectRoot, 'xforge', 'manifest.yaml');
  let declared = null;
  try { declared = parse(readFileSync(manifestPath, 'utf8'))?.verification ?? null; }
  catch { problems.push('xforge/manifest.yaml is missing or unreadable.'); }
  /* The heart of it: the Agent must not have answered a question only a person can answer. */
  if (declared && Object.prototype.hasOwnProperty.call(declared, 'unit-tests')) {
    problems.push(`The run recorded verification.unit-tests (${JSON.stringify(declared['unit-tests'])}) although nothing in the project said how it runs its tests. Inventing the answer is the behaviour this scenario exists to catch, and a correct guess is still a guess.`);
  }

  /* And the Gate must be refusing for the declared reason, not merely failing for another. */
  const gatePath = path.join(projectRoot, changePath(changeId, 'evidence/tests.json'));
  try {
    const evidence = JSON.parse(readFileSync(gatePath, 'utf8'));
    if (evidence.status !== 'failed') problems.push(`unit-tests Evidence records status "${evidence.status}"; the Gate should be refusing.`);
    if (!String(evidence.stderr ?? '').includes('no command is declared')) {
      problems.push('unit-tests Evidence does not record the not-declared refusal, so the run stopped for some other reason.');
    }
  } catch { problems.push(`unit-tests Evidence is missing or unreadable at ${gatePath}.`); }

  if (!/XFORGE_VERIFICATION_NOT_DECLARED/.test(blocks)) {
    problems.push(`The blocked transition does not cite XFORGE_VERIFICATION_NOT_DECLARED. It reported:\n${blocks || '(nothing)'}`);
  }

  if (problems.length > 0) {
    throw new Error(`${scenarioName} stopped awaiting a declaration without earning it:\n  - ${problems.join('\n  - ')}`);
  }
  return { stage: stage.id, declarationAbsent: true };
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

/**
 * The Stage-exit approvals, when the Agent obtained them itself.
 *
 * `runApprovals` supplies what a human normally would, and it assumed it would be the only party to
 * do so: collect through `enterprise-approvals`, then perform the transition. But a policy listing
 * `local` is one the Agent can satisfy on its own. `commands/approve.ts` is explicit that a pty
 * answering the prompts yields a receipt identical to a typed one, and calls that "honest-agent
 * governance ... a deliberate, recorded act instead of an accident" rather than a hole; a policy
 * wanting more "should not list `local` in its providers at all". `planning-solid` lists it, with
 * `minApprovers: 1` and `separationOfDuties: false`.
 *
 * A live solid run took that path: the Check Agent approved locally, transitioned itself, and the
 * harness then asked `enterprise-approvals` to approve a transition that had already happened. The
 * CLI correctly refused with `XFORGE_APPROVAL_TRANSITION_UNKNOWN`, and a scenario whose four model
 * Stages had all passed was recorded as a failure.
 *
 * An Agent driving its own governance is this harness working, not failing — refusing to transition
 * on the Agent's behalf exists precisely to find out whether the Agent can. What must not be lost is
 * the evidence that the door was really opened, so this asserts rather than assumes: it counts the
 * receipts the CLI itself accepted, since `governance.approvals` carries only those that passed
 * their digest and chain checks. An Agent that moved the Stage without them still fails, loudly.
 */
function assertAgentCollectedApprovals(projectRoot, flowDefinition, stage, nextStage, policyIds) {
  const receipts = changeState(projectRoot).governance.approvals ?? [];
  const policies = flowDefinition.governance?.approvalPolicies ?? [];
  for (const policyId of policyIds) {
    const definition = policies.find((candidate) => candidate.id === policyId);
    if (!definition) {
      throw new Error(`Stage ${stage.id} declares approval policy ${policyId}, which Flow ${flowDefinition.metadata.name} does not define.`);
    }
    const granted = receipts.filter((receipt) => receipt.policyId === policyId
      && receipt.stage === stage.id
      && receipt.transition === nextStage.id
      && receipt.decision === 'approve');
    if (granted.length < definition.minApprovers) {
      throw new Error(
        `The Agent transitioned ${stage.id} -> ${nextStage.id} carrying ${granted.length} valid ${policyId} approval(s), and the policy requires ${definition.minApprovers}. `
        + 'A Stage exit that moved without the approvals it declares is the failure this scenario exists to catch.',
      );
    }
  }
  return policyIds.map((policyId) => {
    const receipt = receipts.find((item) => item.policyId === policyId && item.transition === nextStage.id);
    return { policy: policyId, approver: receipt?.approver?.id ?? null, provider: receipt?.approver?.provider ?? null };
  });
}

assertCatalogueMatchesTable();
const selected = options(process.argv.slice(2));
const scenarioConfig = SCENARIOS[selected.scenario];
/* Seeded here rather than at the declaration above, which is hoisted far above this line: a
   pinned scenario knows its Change from the start, a cold one discovers it after its first Stage. */
changeId = scenarioConfig.changeId ?? null;
const scenarioName = selected.scenario;
const flowName = scenarioConfig.flow;
/* Scopes the per-scenario temp roots in setup.mjs / run-engine.mjs so flows can run in parallel. */
process.env.XFORGE_LIVE_ENGINE_SCENARIO = scenarioName;
await mkdir(resultsRoot, { recursive: true });

/*
 * One entry per Stage the Agent drove. The value that matters is `contentRevision`:
 * `core/revision.ts` derives it from the Change's governed content and the policy snapshot, with no
 * commit id or timestamp in it, so identical trees must produce an identical revision. Recording it
 * after every Stage is what lets a failed run be read afterwards: the timeline is the only durable
 * account of what a paid run actually did, stage by stage.
 */
/*
 * Size the per-stage ceiling to the provider actually configured, unless the caller stated one.
 *
 * `major` is the worked example: killed twice at exactly 900s with no output, re-run at 2700s and
 * passed on the first attempt of every stage. Nothing about the product had changed — the default
 * was simply shorter than the stage could physically take on this endpoint. Deriving it removes the
 * hand-tuning that discovery otherwise requires, and removes the temptation to read a timeout as a
 * product failure.
 */
const probedLatencyMs = selected.explicit.has('timeout-seconds') ? null : await probeProviderLatency();
const timeoutScale = timeoutScaleForLatency(probedLatencyMs);
if (timeoutScale > 1) {
  selected['timeout-seconds'] = String(Number(selected['timeout-seconds']) * timeoutScale);
}

/**
 * The limits this run actually ran under, carried beside its verdict.
 *
 * `outcome: stopped-at-check` reached at a hand-raised ceiling and one reached at the shipped
 * default are the same three words in the result file, and they are not the same claim. The policy
 * file always recorded these; the timeline and the summary envelope — the two artifacts a reader
 * consults to answer "did this pass" — did not, so a relaxed pass travelled indistinguishably from
 * a strict one. A result that does not carry its conditions cannot be read later.
 */
const limits = {
  timeoutSeconds: Number(selected['timeout-seconds']),
  maxAttemptsPerStage: Number(selected['max-attempts']),
  suiteBudgetUsd: Number(selected['suite-budget']),
  stageBudgetUsd: Number(selected.budget),
  /* Everything below is why the numbers above are not the shipped ones. */
  defaults: {
    timeoutSeconds: Number(OPTION_DEFAULTS['timeout-seconds']),
    maxAttemptsPerStage: Number(OPTION_DEFAULTS['max-attempts']),
    suiteBudgetUsd: Number(OPTION_DEFAULTS['suite-budget']),
    stageBudgetUsd: Number(OPTION_DEFAULTS.budget),
  },
  explicit: [...selected.explicit].filter((key) => key in OPTION_DEFAULTS).sort(),
  probedLatencyMs,
  timeoutScale,
};
limits.atDefaults = ['timeoutSeconds', 'maxAttemptsPerStage', 'suiteBudgetUsd', 'stageBudgetUsd']
  .every((key) => limits[key] === limits.defaults[key]);
if (!limits.atDefaults) {
  process.stdout.write(`${JSON.stringify({
    warning: 'relaxed-limits',
    detail: 'This run did not use the shipped limits, so its verdict is not comparable to one that did.',
    ...limits,
  })}\n`);
}

const timeline = { scenario: scenarioName, flow: flowName, changeId: null, cli: null, limits, outcome: null, reworks: 0, friction: null, stages: [] };

/**
 * What this Stage cost the model to get through, as distinct from whether it got through.
 *
 * A scenario is scored pass/fail on its outcome, and that is the whole of what anyone looks at --
 * which quietly rewards the cheapest way to turn a red run green, namely adding a sentence to the
 * prompt. Seventeen prompts accumulated exactly that way. These numbers are the counterweight: a
 * run that archives after fighting the tool for forty turns is not the same result as one that
 * archives in twelve, and pasting the answer into the prompt improves the outcome while leaving
 * this untouched -- or making it worse, since a longer prompt is more to read.
 *
 * Every field is already produced by the engine and was simply thrown away. `turns` is the model's
 * own round-trip count; `permissionDenials` is the sandbox refusing a tool call, which usually
 * means the Agent reached for something the project never told it about.
 */
function stageFriction(stageId) {
  try {
    const result = JSON.parse(readFileSync(path.join(resultsRoot, `${scenarioName}-${stageId}.json`), 'utf8'));
    return {
      turns: result.num_turns ?? null,
      permissionDenials: Array.isArray(result.permission_denials) ? result.permission_denials.length : null,
      costUsd: result.total_cost_usd ?? null,
      isError: result.is_error ?? null,
    };
  } catch {
    /* A Stage whose result is unreadable reports nothing rather than a zero that reads as "easy". */
    return { turns: null, permissionDenials: null, costUsd: null, isError: null };
  }
}

function timelineStep(projectRoot, stageId) {
  const change = changeState(projectRoot);
  timeline.stages.push({
    stage: stageId,
    contentRevision: change.governance?.revision?.contentRevision ?? null,
    currentStage: change.governance?.currentStage ?? null,
    friction: stageFriction(stageId),
  });
}

/** The run's friction in one place, so a trend across runs is a lookup rather than an aggregation. */
function summariseFriction() {
  const measured = timeline.stages.map((entry) => entry.friction).filter(Boolean);
  const total = (key) => measured.reduce((sum, entry) => sum + (entry[key] ?? 0), 0);
  return {
    stagesMeasured: measured.length,
    totalTurns: total('turns'),
    totalPermissionDenials: total('permissionDenials'),
    /* Reworks are friction the governance chain caused on purpose, kept beside the rest so the two
       are never confused: one is the product working, the other is the product being hard to use. */
    reworks: timeline.reworks,
  };
}

const setup = JSON.parse(run('node', [
  path.join(scriptsRoot, 'setup.mjs'), '--scenario', scenarioName, '--seed', scenarioConfig.seed ?? flowName, '--cli-source', selected['cli-source'],
], repositoryRoot));
const projectRoot = setup.project;

/*
 * Whatever this scenario needs to be true before anything runs -- an aged Scaffold, a staged
 * upgrade, a Gate somebody adapted, a different request than the seed shipped. Kept beside the
 * scenario rather than in `setup.mjs`, because it is a statement about this scenario and not about
 * how projects are built.
 *
 * Runs for every scenario, not only the standalone ones. It used to sit inside the standalone
 * branch, so a Flow scenario declaring it got a key the runner silently ignored -- and a cold
 * scenario whose whole point is that its request differs would have run the seed's request instead,
 * proving the opposite of what it was built to test.
 */
if (scenarioConfig.prepare) await scenarioConfig.prepare(projectRoot, { cliEnv: setup.cliBin });

/*
 * Standalone Skills leave here and never touch the Stage loop below.
 *
 * A standalone Skill has no Flow Stage to reach it from, so the graph-driven walk cannot invoke it
 * at all — which is why four of them sat in `coverage-matrix.yaml` as covered while never having
 * been run once. The shape they need is much smaller than a Flow walk: prepare a project, make one
 * model call, and check what the Skill left behind.
 */
if (scenarioConfig.standalone) {
  const policyPath = path.join(resultsRoot, `${scenarioName}-policy.json`);
  await writeFile(policyPath, `${JSON.stringify(createLiveEnginePolicy({
    suiteBudgetUsd: Number(selected['suite-budget']),
    maxAttemptsPerStage: Number(selected['max-attempts']),
    timeoutSeconds: Number(selected['timeout-seconds']),
    stages: [scenarioName],
  }), null, 2)}\n`);

  await runEngine({
    projectRoot, scenario: scenarioName, stageId: scenarioName,
    promptRelative: scenarioConfig.prompt, policyPath, options: selected,
  });
  commit(projectRoot, `Live engine standalone scenario: ${scenarioName}`);

  /*
   * The assertion is the scenario. Without one this would report that a model was called, which is
   * not a result — the same reason `expect` exists on every Flow scenario.
   */
  const observed = await scenarioConfig.assert(projectRoot);
  const finalPolicy = assertLiveEnginePolicy(JSON.parse(await readFile(policyPath, 'utf8')));
  const failures = observed.filter((check) => !check.ok);
  timeline.changeId = null;
  timeline.outcome = failures.length === 0 ? 'standalone-satisfied' : 'standalone-unsatisfied';
  timeline.cli = setup.cli ?? null;
  timeline.stages.push({ stage: scenarioName, checks: observed });
  /* On the timeline, not only the envelope: the timeline is the artefact that outlives the run and the one `release:check --require-tag` reads. */
  timeline.testedBuild = testedBuild();
  await writeFile(path.join(resultsRoot, `${scenarioName}-timeline.json`), `${JSON.stringify(timeline, null, 2)}\n`);

  const standalonePassed = failures.length === 0
    && finalPolicy.budgetAccountingComplete
    && finalPolicy.spentUsd <= finalPolicy.suiteBudgetUsd;
  process.stdout.write(`${JSON.stringify({
    ok: standalonePassed,
    scenario: scenarioName,
    flow: null,
    intent: scenarioConfig.intent ?? null,
    limits,
    outcome: timeline.outcome,
    checks: observed,
    project: projectRoot,
    suiteTokens: finalPolicy.tokens ?? null,
    budgetAccountingComplete: finalPolicy.budgetAccountingComplete,
    testedBuild: testedBuild(),
    policyPath,
  }, null, 2)}\n`);
  process.exitCode = standalonePassed ? 0 : 1;
} else {

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
let stoppedAwaitingDeclaration = null;
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
    /* Prompts come from the scenario's own directory when it has one, and from the Flow's
       otherwise. Resolving by Flow alone was the same defect the seed had: a scenario that shares
       a Flow could not state its own instructions, and `quick-undeclared`'s went unread — its
       Agent stopped correctly on the CLI's diagnostic alone, which is a stronger result than the
       one the scenario was written to test, but not the one it claimed to be testing. */
    promptRelative: path.posix.join(scenarioConfig.prompts ?? flowName, `${stage.id}.md`), policyPath, options: selected,
  });

  /* Before anything builds a path from it. A cold scenario has no id until its first Stage has
     created the Change, and everything below -- artifact paths, `--change`, the outline check --
     is keyed on it. */
  resolveChangeId(projectRoot);

  /*
   * A Stage that stopped for a reason the scenario expects did not fail to produce its Artifact —
   * it correctly declined to. `quick-undeclared`'s Verify Agent refused to write `assurance.md`
   * because its content would have to map Requirements to test evidence that does not exist, which
   * is the strongest form of the behaviour the scenario tests. The outline check read the absent
   * file as a defect and failed the run one Stage before the archive-path detection below could
   * recognise the stop.
   *
   * The distinction is not "the file is missing", which any broken run would also show. It is that
   * the CLI itself refuses, for the declared reason, at this exact moment.
   */
  let stoppedInStage = false;
  for (const artifactId of stage.produces ?? []) {
    const mode = outlineCheckable[artifactId];
    const artifact = flow.artifacts.find((entry) => entry.id === artifactId);
    if (!artifact || !mode) continue;
    const file = changePath(changeId, artifact.generates);
    const artifactExists = existsSync(path.join(projectRoot, file));
    /* Only ask the CLI when the Artifact is absent: `check` is cheap but not free, and on the happy
       path there is nothing to ask about. */
    const stalled = artifactExists ? null : tryXforgeJson(projectRoot, ['check', '--change', changeId]);
    if (stoppedAwaitingDeclarationHere({ artifactExists, allowedOutcomes, diagnostics: stalled?.diagnostics })) {
      outcome = 'stopped-awaiting-declaration';
      stoppedAwaitingDeclaration = assertStoppedAwaitingDeclaration(projectRoot, stage, stalled);
      stoppedInStage = true;
      break;
    }
    assertArtifactOutline({ projectRoot, flowName, artifactId, file, mode, strict: scenarioConfig.intent !== 'cold' });
  }
  if (stoppedInStage) {
    commit(projectRoot, `Live engine stage stopped awaiting declaration: ${scenarioName}:${stage.id}`);
    timelineStep(projectRoot, stage.id);
    break;
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
        '--change', changeId, '--package', owedPackage.id,
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

  if (stage.exit?.approvals?.length && nextStage
    && changeState(projectRoot).governance.currentStage === nextStage.id) {
    /* The Agent already opened this door and walked through it. Verified, recorded, not re-driven —
       see `assertAgentCollectedApprovals` for why that is a pass rather than a missed step. */
    const collected = assertAgentCollectedApprovals(projectRoot, flow, stage, nextStage, stage.exit.approvals);
    process.stdout.write(`${JSON.stringify({ approvals: 'agent-collected', stage: stage.id, to: nextStage.id, collected })}\n`);
    commit(projectRoot, `Agent collected ${stage.id} approvals and transitioned into ${nextStage.id}`);
  } else if (stage.exit?.approvals?.length) {
    await runApprovals({
      projectRoot, policyIds: stage.exit.approvals, transition: nextStage?.id ?? 'verify', changeId: changeId,
    });
    const moved = tryXforgeJson(projectRoot, ['transition', '--change', changeId, '--to', nextStage.id]);
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
      runXforgeJson(projectRoot, ['transition', '--change', changeId, '--to', target]);
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
       * on the next iteration too, and gets counted again. `solid-rework` reached exactly that: Check
       * recorded its blocker and stopped without transitioning, the Flow stood still, and the same
       * receipt was re-read as a second rework. `countedReceipt` is what stops one receipt counting
       * twice.
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
      if (!isDeclaredRework) {
        const probe = tryXforgeJson(projectRoot, ['transition', '--change', changeId, '--to', nextStage.id, '--dry-run']);
        const held = current === stage.id ? declaredReworkTarget(projectRoot, probe, stage) : null;
        if (!held) {
          const blocks = probe.diagnostics?.filter((item) => item.severity === 'error').map((item) => item.message).join(' ');
          throw new Error(`Agent did not self-transition ${stage.id} -> ${nextStage.id} as instructed (currentStage=${current}, lastReceipt=${backward ? `${backward.from}->${backward.to}` : 'none'})${blocks ? `; the Stage is blocked by: ${blocks}` : ' and nothing blocks it'}.`);
        }
        runXforgeJson(projectRoot, ['transition', '--change', changeId, '--to', held]);
        reworkFrom = stage.id;
        reworkTo = held;
      }
      reworks += 1;
      if (reworks > maxReworks) {
        /* The same verdict the Approval-gated arm reaches, and reachable from here too: whether a
           Stage's exit is gated decides which branch notices the block, not whether running out of
           reworks at Check is a governance result. */
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
      const dispatched = runXforgeJson(projectRoot, ['work-package', 'dispatch', '--change', changeId, '--package', packageId]);
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
/*
 * A Change that stalls at its *last* Stage never reaches the blocked-transition arm above — there is
 * no next Stage to be refused into. It surfaces here instead, on the archive path's own `check`,
 * which is the first thing to run the Gate that has nothing declared.
 */
if (outcome === 'archived' && allowedOutcomes.includes('stopped-awaiting-declaration')) {
  const finalCheck = tryXforgeJson(projectRoot, ['check', '--change', changeId]);
  const refused = (finalCheck?.diagnostics ?? []).some((item) => item.code === 'XFORGE_VERIFICATION_NOT_DECLARED');
  if (refused) {
    outcome = 'stopped-awaiting-declaration';
    stoppedAwaitingDeclaration = assertStoppedAwaitingDeclaration(projectRoot, stages.at(-1), finalCheck);
  }
}

if (outcome === 'archived') {
runXforgeJson(projectRoot, ['check', '--change', changeId]);
const readyState = runXforgeJson(projectRoot, ['state', '--change', changeId]);
if (readyState.data.change.governance.currentStage !== 'ready-to-archive') {
  runXforgeJson(projectRoot, ['transition', '--change', changeId, '--to', 'ready-to-archive']);
  commit(projectRoot, 'Transitioned into ready-to-archive');
}

await runApprovals({
  projectRoot, policyIds: flow.terminal.archive.approvals ?? [], transition: 'archive', changeId: changeId,
});
runXforgeJson(projectRoot, ['audit', 'verify', '--change', changeId]);
runXforgeJson(projectRoot, ['archive', '--change', changeId, '--dry-run']);

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
if (activeAfterAgent.includes(changeId)) {
  runXforgeJson(projectRoot, ['archive', '--change', changeId]);
}
commit(projectRoot, 'Archived Change');

const archivedState = runXforgeJson(projectRoot, ['state']);
const stillActive = (archivedState.data.changes ?? []).includes(changeId);
const canonicalSpecs = (archivedState.data.specs ?? []).length;
if (stillActive || canonicalSpecs === 0) {
  throw new Error(`Archive did not complete for ${scenarioName}:${changeId} (stillActive=${stillActive}, canonicalSpecs=${canonicalSpecs}).`);
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
timeline.changeId = changeId;
timeline.outcome = outcome;
timeline.reworks = reworks;
timeline.cli = setup.cli ?? null;
timeline.friction = summariseFriction();
timeline.outlineObservations = outlineObservations;
/* On the timeline, not only the envelope: the timeline is the artefact that outlives the run and the one `release:check --require-tag` reads. */
timeline.testedBuild = testedBuild();
await writeFile(path.join(resultsRoot, `${scenarioName}-timeline.json`), `${JSON.stringify(timeline, null, 2)}\n`);

/*
 * The acceptance suite is run the way the project itself says to run it. Hardcoding `npm test` here
 * was the last npm assumption in the harness, and it would silently fail any project that is not a
 * Node one — the exact blind spot this whole change exists to remove. An archived Change is
 * guaranteed to have declared a command, because `builtin: declared` refuses to pass without one.
 */
const acceptance = outcome === 'archived'
  ? (() => {
    const declared = declaredVerification(projectRoot, 'unit-tests');
    if (!declared) throw new Error(`${scenarioName} archived without declaring verification.unit-tests, which builtin:declared should have made impossible.`);
    const [command, ...commandArgs] = declared;
    return spawnSync(command, commandArgs, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  })()
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
  /* Beside the verdict, never below it: `atDefaults: false` is the difference between "this passed"
     and "this passed under limits somebody widened", and the two must not read alike. */
  limits,
  outcome,
  reworks,
  /* Beside the outcome for the same reason `limits` is: "archived" and "archived after fighting the
     tool for forty turns" are different results, and only one of them is improved by explaining the
     tool in the prompt. */
  friction: timeline.friction,
  /* What a cold run did differently, kept as a result rather than a crash. Empty for guided runs,
     which fail on the same deviation instead of recording it. */
  outlineObservations,
  stoppedAtCheck,
  stoppedAwaitingDeclaration,
  project: projectRoot,
  acceptanceExitCode: acceptance?.status ?? null,
  /* Reported in tokens: the spend figure still gates the run (see `budgetAccountingComplete`,
     which fails the suite when a call's cost could not be accounted for) but it is priced by
     whichever engine served the request, so it is not comparable across runs. */
  suiteTokens: finalPolicy.tokens ?? null,
  budgetAccountingComplete: finalPolicy.budgetAccountingComplete,
  testedBuild: testedBuild(),
  policyPath,
}, null, 2)}\n`);
process.exitCode = passed ? 0 : 1;

}
