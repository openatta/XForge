import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cassetteFiles, cassettesRoot, modelStepFromSubject, scaffoldFingerprint } from './cassette.mjs';

/**
 * Packages a finished live run into a cassette that `run-matrix.mjs --replay` can drive.
 *
 * Run this immediately after a green run of the same scenario, against the isolated project it left
 * behind. Nothing is re-executed here and no model is called: the run already produced an ordered
 * commit per step, so recording is bundling that history and writing down what the replay must
 * reproduce.
 */

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const temporaryRoot = path.join(repositoryRoot, 'tests', '.tmp');

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Expected key/value options.');
    result[key.slice(2)] = value;
  }
  if (!result.scenario) throw new Error('--scenario is required.');
  return result;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

const selected = options(process.argv.slice(2));
const scenario = selected.scenario;
const projectRoot = path.resolve(temporaryRoot, `live-engine-${scenario}`);
if (!existsSync(path.join(projectRoot, '.git'))) {
  throw new Error(`No finished run to record at ${projectRoot}. Run the scenario first.`);
}

/*
 * The timeline is written by the run itself, one entry per Stage, carrying the `contentRevision`
 * the CLI reported at that moment. It is the sharpest thing a replay can assert: the revision is
 * `sha256({change, flow, inputs, policySnapshotDigest})` -- content-derived, with no commit id or
 * timestamp in it -- so replaying the same trees must reproduce the same value, and any drift in
 * how governed content is digested shows up immediately rather than as a late, vague failure.
 */
const timelinePath = path.join(temporaryRoot, 'live-engine-results', `${scenario}-timeline.json`);
if (!existsSync(timelinePath)) {
  throw new Error(`No timeline at ${timelinePath}; record from a run of the current harness, which writes one.`);
}
/*
 * The run writes its timeline once, at the very end. A run that dies partway therefore leaves the
 * *previous* run's timeline sitting at this path, and recording would pair those stale stages with
 * the new project's Git history — a cassette that looks complete and replays against revisions the
 * recorded commits never produced. Existence alone cannot distinguish the two; the timestamps can,
 * because a finished run always writes its timeline after its last commit.
 */
const lastCommitEpoch = Number(git(['log', '-1', '--format=%ct'], projectRoot).trim()) * 1000;
const timelineWrittenAt = statSync(timelinePath).mtimeMs;
if (timelineWrittenAt < lastCommitEpoch) {
  throw new Error(
    `Timeline at ${timelinePath} predates the last commit in ${projectRoot}, so it belongs to an earlier run `
    + '— the run you are recording did not finish. Re-run the scenario to completion before recording.',
  );
}
const timeline = JSON.parse(await readFile(timelinePath, 'utf8'));
if (timeline.scenario !== scenario) {
  throw new Error(`Timeline at ${timelinePath} records scenario "${timeline.scenario}", not "${scenario}".`);
}

/* `--reverse` so the steps read in the order they happened; the separator is a tab because a commit
   subject may contain anything else, including the colons the step names use. */
const log = git(['log', '--reverse', '--format=%H%x09%s'], projectRoot).trim().split('\n');
const steps = [];
for (const line of log) {
  const [commit, ...rest] = line.split('\t');
  const subject = rest.join('\t');
  const stage = modelStepFromSubject(subject, scenario);
  if (!stage) continue;
  const parent = git(['rev-parse', `${commit}^`], projectRoot).trim();
  const changed = git(['diff', '--name-status', parent, commit], projectRoot).trim();
  steps.push({
    stage,
    commit,
    parent,
    subject,
    /* Recorded for the manifest's readability and for a fast sanity check at replay time; the
       authoritative list is re-derived from the bundle, which cannot drift from the trees. */
    files: changed ? changed.split('\n').length : 0,
  });
}
if (steps.length === 0) throw new Error(`No model steps found in ${projectRoot}; is ${scenario} the scenario that produced it?`);

await mkdir(cassettesRoot, { recursive: true });
const files = cassetteFiles(scenario);
git(['bundle', 'create', files.bundle, '--all'], projectRoot);

const manifest = {
  apiVersion: 'xforge-live-engine/v1',
  kind: 'Cassette',
  scenario,
  flow: timeline.flow,
  changeId: timeline.changeId,
  recordedAt: new Date().toISOString(),
  /* Refusing a replay against a changed Scaffold is the whole reason this is here; see cassette.mjs. */
  scaffold: scaffoldFingerprint(),
  cli: timeline.cli ?? null,
  outcome: timeline.outcome,
  reworks: timeline.reworks,
  steps,
  stages: timeline.stages,
};
await writeFile(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  scenario,
  manifest: files.manifest,
  bundle: files.bundle,
  modelSteps: steps.length,
  stagesRecorded: (timeline.stages ?? []).length,
  scaffold: manifest.scaffold,
}, null, 2)}\n`);
