import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveEnginePolicy } from '../live-engine/policy.mjs';
import { installCli } from '../live-engine/cli-source.mjs';

/**
 * One Stage, one model call, one set of assertions.
 *
 * The full Flow scenarios answer "does the whole graph hold together" and cost an hour and about
 * sixteen dollars to say it. Most changes do not need that question answered; they need "does the
 * Agent do the right thing at this one Stage now". This runs that, from a frozen fixture, for
 * roughly two dollars and a few minutes.
 *
 * It refuses rather than guesses. A fixture produced under a different Flow describes a Change
 * nobody would write today, so a version or digest mismatch stops the run before it spends
 * anything -- the failure mode this whole exercise has been about is a check that keeps reporting
 * while the thing beneath it has moved.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.join(here, '..', '..');
const workRoot = path.join(repositoryRoot, 'tests', '.tmp');

function options(argv) {
  const parsed = { 'max-attempts': '1', 'timeout-seconds': '1800', budget: '3', 'suite-budget': '5', 'overlay-skills': 'true' };
  for (let index = 0; index < argv.length; index += 2) {
    const [key, value] = [argv[index], argv[index + 1]];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Expected --key value pairs.');
    parsed[key.slice(2)] = value;
  }
  if (!parsed.fixture) throw new Error('--fixture is required (a directory under tests/probe/fixtures).');
  return parsed;
}

const selected = options(process.argv.slice(2));
const fixture = path.join(here, 'fixtures', selected.fixture);
if (!existsSync(fixture)) throw new Error(`No fixture at ${path.relative(repositoryRoot, fixture)}. Create one with snapshot.mjs.`);

const manifest = JSON.parse(await readFile(path.join(fixture, 'probe-fixture.json'), 'utf8'));

/*
 * Flow drift, stated rather than assumed either way.
 *
 * A probe exists to measure a Flow change, so refusing whenever the Flow has changed would refuse
 * the only case it was built for. But the Artifacts frozen in a fixture were written against the
 * Flow of the day, and if the change touches an earlier Stage they describe a Change nobody would
 * write now -- which is the silent-drift failure this whole exercise has been about.
 *
 * So the operator decides, explicitly, and the decision travels with the result. `--accept-flow-drift`
 * is the same bargain the live harness makes with `relaxed-limits`: a verdict reached under
 * conditions somebody widened must not read like one that was not.
 */
const shippedFlowPath = path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'flows', `${manifest.flow}.yaml`);
const shippedText = await readFile(shippedFlowPath, 'utf8');
const shippedDigest = createHash('sha256').update(shippedText).digest('hex');
const { parse: parseYaml } = await import('../../xforge/node_modules/yaml/dist/index.js');
const shippedVersion = String(parseYaml(shippedText).metadata?.version ?? 'unknown');
const flowDrift = shippedDigest === manifest.flowDigest
  ? null
  : { fixtureVersion: manifest.flowVersion, shippedVersion, accepted: selected['accept-flow-drift'] === 'true' };

if (flowDrift && !flowDrift.accepted) {
  throw new Error([
    `Fixture ${selected.fixture} was captured under ${manifest.flow} version ${manifest.flowVersion}; the shipped Flow is version ${shippedVersion} and does not match it.`,
    '',
    '  That is expected when the change under test is to this Flow, and it is a stale fixture when',
    '  the change touched a Stage this fixture already baked in. Only you can tell those apart.',
    '',
    '  Re-run with --accept-flow-drift true to measure anyway (the result will say so), or',
    '  recapture the fixture with snapshot.mjs.',
  ].join('\n'));
}

/* A working copy, so a probe never mutates the fixture it was measured from. */
const projectRoot = path.join(workRoot, `probe-${selected.fixture}`);
await rm(projectRoot, { recursive: true, force: true });
await mkdir(workRoot, { recursive: true });
await cp(fixture, projectRoot, { recursive: true });
/* The Flow the fixture froze is replaced by the one under test -- that difference is the point. */
await cp(shippedFlowPath, path.join(projectRoot, 'xforge', 'flows', `${manifest.flow}.yaml`));

/*
 * The Skills the fixture froze, replaced by the ones under test -- for the same reason the Flow is.
 *
 * A fixture is a whole project frozen at a Stage boundary, and a project contains its Skills. So a
 * probe run against it measured the Skill of the day it was captured, not the Skill in the working
 * tree: `quick-propose` still carried an `xforge-propose` whose first Invariant read
 * `Run \`xforge state\`` with no `--field` at all, two rewrites behind. Nothing said so. The probe
 * reported a verdict on a Stage while the instruction that drives that Stage had moved, which is
 * the silent-drift failure this file refuses everywhere else -- and it made the cheap tier
 * structurally unable to answer the question Skills are edited to answer, so every Skill change
 * owed a full scenario instead.
 *
 * Only `xforge/scaffold/skills/` is written, never the projected copies under `.claude/` and its
 * peers. Those are managed files with recorded digests: writing one by hand makes the next managed
 * operation refuse with `XFORGE_MANAGED_FILE_MODIFIED`, which is the ownership record working
 * correctly. `xforge update` below is what carries the new text into every target, exactly as it
 * would in a real project.
 */
const payloadSkills = path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'scaffold', 'skills');
const projectSkills = path.join(projectRoot, 'xforge', 'scaffold', 'skills');
const overlaySkills = selected['overlay-skills'] !== 'false';
const replacedSkills = [];
if (overlaySkills) {
  for (const skill of (await readdir(payloadSkills, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
    /* Only Skills this fixture actually selects. A Skill the project never adopted is not this
       probe's business, and writing one in would change what the project is. */
    if (!existsSync(path.join(projectSkills, skill.name))) continue;
    for (const variant of ['SKILL.md', 'SKILL_cn.md']) {
      const source = path.join(payloadSkills, skill.name, variant);
      const target = path.join(projectSkills, skill.name, variant);
      if (!existsSync(source) || !existsSync(target)) continue;
      const shipped = await readFile(source, 'utf8');
      if (shipped === await readFile(target, 'utf8')) continue;
      await writeFile(target, shipped);
      replacedSkills.push(path.relative(projectRoot, target));
    }
  }
}

/*
 * A Stage with no case of its own still gets measured.
 *
 * `cases/<stage>.mjs` holds what is specific to a Stage — the Check Agent keeping its verdict out of
 * the prose, and so on. Everything else a Stage owes is stated by the Flow already: which Artifacts
 * it produces, where each one lands, and what sections it declares. `_generic.mjs` reads that, so a
 * fixture for a Stage nobody has written a case for is worth capturing rather than worth nothing.
 */
const casePath = path.join(here, 'cases', `${manifest.stage}.mjs`);
const caseModule = existsSync(casePath)
  ? await import(casePath)
  : await import(path.join(here, 'cases', '_generic.mjs'));
const caseContext = { projectRoot, change: manifest.change, repositoryRoot, flow: manifest.flow, stage: manifest.stage };
await caseModule.prepare?.(caseContext);

/*
 * The CLI the Agent will find on PATH, installed beside the project the way the live harness does.
 *
 * `run-engine.mjs` prepends `cliBinDirectory(projectRoot)` — `<projectRoot>-tmp/cli/node_modules/.bin`
 * — and nothing here ever put a CLI there, so `xforge` fell through to whatever the machine had
 * installed globally. That was survivable while the published CLI and the working tree agreed and
 * became a wrong answer the moment they did not: a probe run against a fixture carrying
 * `scaffold.flows` met the published 0.7.18, which has no such property, and every `xforge` call in
 * the session died on `XFORGE_SCHEMA_INVALID`. The Agent diagnosed it correctly and reported an
 * environmental blocker — forty turns and a real charge to discover that the probe had not
 * installed the thing under test.
 *
 * `local` rather than `npm`, always: a probe exists to measure the working tree, and installing the
 * published version would measure the last release instead, silently.
 */
const cliRoot = path.join(`${projectRoot}-tmp`, 'cli');
await rm(cliRoot, { recursive: true, force: true });
const cli = await installCli({
  cliRoot,
  mode: 'local',
  packRoot: path.join(`${projectRoot}-tmp`, 'npm-pack'),
  npmCache: process.env.XFORGE_LIVE_ENGINE_NPM_CACHE,
});

/*
 * The identity the fixture declares, moved to the CLI the probe actually provisions.
 *
 * Every fixture pins the CLI of the day it was captured and the probe always installs the working
 * tree's build, so the two disagree by construction -- and the disagreement is not cosmetic. The
 * fixture ships a fail-closed `agent.tool.before` Hook, so the governance dispatcher denied *every*
 * tool call the Agent made, including `xforge state`. The Agent then did the right thing: it read
 * the diagnostic, stopped, and wrote nothing. Both Artifact checks failed, and the failure looked
 * exactly like a Skill that does not produce its Artifacts.
 *
 * `xforge update` is the supported move for this and only this: it advances the CLI pin and leaves
 * `manifest.scaffold.version` where the files are, so the Scaffold stays the fixture's own. It also
 * reprojects, which is how the overlaid Skills reach `.claude/` and its peers.
 *
 * The outcome is checked rather than the exit code. `update` legitimately reports `ok: false` for
 * warnings a fixture will always carry -- its Scaffold is behind the CLI by definition -- so the
 * question is whether the identities now agree, which `state` answers directly.
 */
function runCli(args) {
  return spawnSync(process.execPath, [cli.installedCliPath, '--root', projectRoot, ...args], { encoding: 'utf8' });
}

const updateResult = runCli(['update']);
/*
 * Three shapes, because `--field` narrows differently depending on how the call went, and a reader
 * written for one of them reads the other two as "no answer". A single field on `ok: true` prints
 * the bare value and nothing else; several fields print an object keyed by the paths asked for; a
 * refusal keeps the whole envelope and narrows only `data`.
 */
const compatibility = JSON.parse(runCli(['state', '--field', 'project.compatibility']).stdout || '{}');
const declared = compatibility.cli
  ? compatibility
  : compatibility.data?.['project.compatibility'] ?? compatibility['project.compatibility'] ?? null;
if (!declared?.cli?.matches) {
  throw new Error([
    `The fixture still declares ${declared?.cli?.declared ?? 'an unknown CLI'} while the probe provisioned ${cli.version}.`,
    '',
    '  The fixture ships a fail-closed governance Hook, so every tool call the Agent makes would be',
    '  denied and the run would measure nothing. `xforge update` was supposed to align them.',
    '',
    `  update said: ${(updateResult.stdout || updateResult.stderr || '').slice(0, 600)}`,
  ].join('\n'));
}

const resultsRoot = path.join(workRoot, 'probe-results');
await mkdir(resultsRoot, { recursive: true });
const outputPath = path.join(resultsRoot, `${selected.fixture}.json`);
const policyPath = path.join(resultsRoot, `${selected.fixture}-policy.json`);
await rm(policyPath, { force: true });
await writeFile(policyPath, `${JSON.stringify(createLiveEnginePolicy({
  stages: [manifest.stage],
  suiteBudgetUsd: Number(selected['suite-budget']),
  maxAttemptsPerStage: Number(selected['max-attempts']),
  timeoutSeconds: Number(selected['timeout-seconds']),
}), null, 2)}\n`);

/*
 * The Stage prompt, from whichever scenario directory actually carries one.
 *
 * This used to name `<flow>-cold` and nothing else, which is a directory only `major` has — so a
 * fixture for any other Flow pointed at a file that does not exist and the probe died after doing
 * all the setup. Cold is preferred where it exists because it hands the Agent less, and the Flow's
 * own scenario is the fallback every Flow has.
 */
const promptCandidates = selected.prompt
  ? [path.resolve(selected.prompt)]
  : [`${manifest.flow}-cold`, manifest.flow].map((scenario) =>
    path.join(repositoryRoot, 'tests', 'live-engine', 'scenarios', scenario, `${manifest.stage}.md`));
const prompt = promptCandidates.find((candidate) => existsSync(candidate));
if (!prompt) {
  throw new Error([
    `No prompt for ${manifest.flow}:${manifest.stage}. Looked for:`,
    ...promptCandidates.map((candidate) => `  ${path.relative(repositoryRoot, candidate)}`),
    '  Pass --prompt <file> to name one directly.',
  ].join('\n'));
}

const engine = spawnSync(process.execPath, [
  path.join(repositoryRoot, 'tests', 'live-engine', 'run-engine.mjs'),
  '--root', projectRoot, '--prompt', prompt, '--output', outputPath,
  '--stage', manifest.stage, '--policy', policyPath,
  '--suite-budget', selected['suite-budget'], '--budget', selected.budget,
  '--max-attempts', selected['max-attempts'], '--timeout-seconds', selected['timeout-seconds'],
  '--allow-behavioral-isolation', 'true',
], { encoding: 'utf8', stdio: 'inherit' });

if (engine.status !== 0) throw new Error(`Engine call failed for ${manifest.flow}:${manifest.stage}. See ${outputPath}.`);

const checks = await caseModule.assert(caseContext);
const failures = checks.filter((check) => !check.ok);
const run = JSON.parse(await readFile(outputPath, 'utf8'));
process.stdout.write(`${JSON.stringify({
  ok: failures.length === 0,
  /* Beside the verdict, never below it. */
  ...(flowDrift ? { warning: 'flow-drift', flowDrift } : {}),
  fixture: selected.fixture,
  flow: manifest.flow,
  stage: manifest.stage,
  /* Which CLI the Agent actually had. Reported because the run that made this necessary looked
     exactly like a Stage failure until somebody read the diagnostics inside it. */
  cli: { version: cli.version, source: cli.source },
  /* Which Skills the Agent actually read. A verdict reached against a frozen Skill is a verdict
     about the day the fixture was captured, so the choice is recorded rather than assumed. */
  skills: overlaySkills ? { overlaid: replacedSkills.length, files: replacedSkills } : { overlaid: false, reason: '--overlay-skills false' },
  /* The fixture pins an older CLI by construction; this says the probe moved it rather than
     leaving the Agent to be denied by the fail-closed Hook. */
  identity: { declared: declared.cli.declared, actual: declared.cli.actual, scaffold: declared.scaffold.declared },
  checks,
  friction: { turns: run.num_turns ?? null, permissionDenials: run.permission_denials?.length ?? null, costUsd: run.total_cost_usd ?? null },
  project: projectRoot,
}, null, 2)}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
