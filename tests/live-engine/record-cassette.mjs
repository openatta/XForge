import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';
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

/*
 * Decide here, for free, whether this recording can be replayed at all.
 *
 * A replay re-signs approvals, so its receipts land at freshly minted UUIDs. A Constitution
 * principle that cites an approval receipt and nothing else therefore points at a file the replay
 * never creates, and `constitution-check` refuses it — correctly, since a citation nobody can
 * follow is not evidence. That surfaces at replay time as a gate failure deep inside the Flow,
 * which reads exactly like a product defect and costs a full diagnosis every time it recurs. It
 * recurs because it is not bad luck: for a principle about governance, an approval receipt is the
 * evidence a Check Agent naturally reaches for.
 *
 * This was known and written down in README.md, and written down was not enough — nothing in the
 * harness acted on it. So the recording states it, the way a cassette already states the Scaffold
 * it was made against: enforced rather than remembered. It is a property of this recording, not of
 * the scenario, so a later run that cites a Requirement id alongside the receipt records as
 * replayable with no change here.
 */
const APPROVAL_RECEIPT = /(?:^|\/)approvals\/[^/]+\/[0-9a-f-]{36}\.json$/;
function unreplayableReason() {
  const touched = new Set(
    git(['log', '--all', '--pretty=format:', '--name-only'], projectRoot)
      .split('\n').map((line) => line.trim())
      .filter((line) => line.endsWith('evidence/constitution-check.yaml')),
  );
  for (const file of touched) {
    const commit = git(['log', '-1', '--format=%H', '--', file], projectRoot).trim();
    if (!commit) continue;
    let ledger;
    try {
      ledger = parse(git(['show', `${commit}:${file}`], projectRoot));
    } catch { continue; }
    for (const principle of ledger?.principles ?? []) {
      const references = principle?.references ?? [];
      if (references.length === 0) continue;
      if (references.every((reference) => APPROVAL_RECEIPT.test(String(reference)))) {
        return `${file}: principle "${principle.principle}" cites an approval receipt and nothing else. `
          + 'A replay mints its own approval UUIDs, so that citation cannot resolve and constitution-check '
          + 'refuses it. See tests/live-engine/README.md — the fix is to constrain citations in the '
          + 'xforge-check Skill, which invalidates every cassette, so it belongs with the next Skill change.';
      }
    }
  }
  return null;
}
const unreplayable = unreplayableReason();

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
  /* Null means replayable. A reason means `--replay` refuses up front, with it. */
  unreplayableReason: unreplayable,
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
  replayable: unreplayable === null,
  unreplayableReason: unreplayable,
}, null, 2)}\n`);
