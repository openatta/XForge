import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveEnginePolicy } from '../live-engine/policy.mjs';

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
  const parsed = { 'max-attempts': '1', 'timeout-seconds': '1800', budget: '3', 'suite-budget': '5' };
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

const caseModule = await import(path.join(here, 'cases', `${manifest.stage}.mjs`));
await caseModule.prepare?.({ projectRoot, change: manifest.change });

const resultsRoot = path.join(workRoot, 'probe-results');
await mkdir(resultsRoot, { recursive: true });
const outputPath = path.join(resultsRoot, `${selected.fixture}.json`);
const policyPath = path.join(resultsRoot, `${selected.fixture}-policy.json`);
await rm(policyPath, { force: true });
const { writeFile } = await import('node:fs/promises');
await writeFile(policyPath, `${JSON.stringify(createLiveEnginePolicy({
  stages: [manifest.stage],
  suiteBudgetUsd: Number(selected['suite-budget']),
  maxAttemptsPerStage: Number(selected['max-attempts']),
  timeoutSeconds: Number(selected['timeout-seconds']),
}), null, 2)}\n`);

const prompt = selected.prompt
  ? path.resolve(selected.prompt)
  : path.join(repositoryRoot, 'tests', 'live-engine', 'scenarios', `${manifest.flow}-cold`, `${manifest.stage}.md`);

const engine = spawnSync(process.execPath, [
  path.join(repositoryRoot, 'tests', 'live-engine', 'run-engine.mjs'),
  '--root', projectRoot, '--prompt', prompt, '--output', outputPath,
  '--stage', manifest.stage, '--policy', policyPath,
  '--suite-budget', selected['suite-budget'], '--budget', selected.budget,
  '--max-attempts', selected['max-attempts'], '--timeout-seconds', selected['timeout-seconds'],
  '--allow-behavioral-isolation', 'true',
], { encoding: 'utf8', stdio: 'inherit' });

if (engine.status !== 0) throw new Error(`Engine call failed for ${manifest.flow}:${manifest.stage}. See ${outputPath}.`);

const checks = await caseModule.assert({ projectRoot, change: manifest.change, repositoryRoot });
const failures = checks.filter((check) => !check.ok);
const run = JSON.parse(await readFile(outputPath, 'utf8'));
process.stdout.write(`${JSON.stringify({
  ok: failures.length === 0,
  /* Beside the verdict, never below it. */
  ...(flowDrift ? { warning: 'flow-drift', flowDrift } : {}),
  fixture: selected.fixture,
  flow: manifest.flow,
  stage: manifest.stage,
  checks,
  friction: { turns: run.num_turns ?? null, permissionDenials: run.permission_denials?.length ?? null, costUsd: run.total_cost_usd ?? null },
  project: projectRoot,
}, null, 2)}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
