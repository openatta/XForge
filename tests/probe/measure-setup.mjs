import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A Stage set up for a measurement run, and nothing spawned.
 *
 * `probe.mjs` answers "does the Agent do the right thing at this Stage" and pays an external model
 * to find out. This answers a different question -- "how many calls does it take" -- and the
 * instrument for that has to be cheap enough to run five times per Stage, because a single sample
 * cannot separate a real change from run-to-run variance. A paid probe measured twice at 38 and 49
 * turns on the same fixture with the same Skill; nothing could be concluded from either number.
 *
 * So the setup is split from the driving. This produces a project ready for whatever agent the
 * caller has, prints where it is, and stops. `measure-assert.mjs` judges the result afterwards
 * with the *same* `cases/<stage>.mjs` module the paid probe uses, so the two instruments agree on
 * what "done correctly" means and their turn counts can be compared.
 *
 * What this deliberately does not reproduce: the fixture's fail-closed governance Hook and its
 * permission policy. Those live in the project's `.claude/settings.json` and only apply to an agent
 * the live harness starts inside that project. A run driven from outside sees neither, so this
 * instrument cannot measure denial-driven friction -- which is why a paid probe stays in the plan
 * as a calibration point rather than being replaced by this.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.join(here, '..', '..');
const cli = path.join(repositoryRoot, 'xforge', 'dist', 'cli.js');

const KNOWN = { fixture: 'fixture directory under tests/probe/fixtures', run: 'run number, distinguishing parallel projects' };

function options(argv) {
  const parsed = { run: '1' };
  for (let index = 0; index < argv.length; index += 2) {
    const [key, value] = [argv[index], argv[index + 1]];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Expected --key value pairs.');
    /* An unknown key used to be stored and ignored, so `--out <dir>` looked like it worked and the
       run was silently written to `--run`'s default instead -- overwriting the previous run rather
       than creating a new one. A wrong flag must fail here, not three commands later. */
    if (!Object.hasOwn(KNOWN, key.slice(2))) throw new Error(`Unknown option ${key}. Known: ${Object.keys(KNOWN).map((name) => `--${name}`).join(', ')}.`);
    parsed[key.slice(2)] = value;
  }
  if (!parsed.fixture) throw new Error('--fixture is required.');
  return parsed;
}

const selected = options(process.argv.slice(2));
const fixture = path.join(here, 'fixtures', selected.fixture);
if (!existsSync(fixture)) throw new Error(`No fixture at ${path.relative(repositoryRoot, fixture)}.`);
const manifest = JSON.parse(await readFile(path.join(fixture, 'probe-fixture.json'), 'utf8'));

/*
 * The CLI is copied into the measurement project, not referenced from the repository.
 *
 * Twice in one session a measured run was destroyed by a rebuild of `xforge/dist/cli.js` underneath
 * it: once mid-flight `MODULE_NOT_FOUND` because the file did not exist for a moment, and after that
 * `XFORGE_LOCK_CLI_MISMATCH` on every later call because the integrity had moved. Both times the
 * agent behaved correctly and reported an environment failure; both times the sample was lost.
 *
 * A rule for the operator did not hold — it was written down after the first time and broken the
 * second. So the instrument stops depending on one: a run reads its own frozen copy, and what the
 * repository does afterwards cannot reach it. `probe.mjs` reached the same conclusion by a different
 * route, installing a tarball per run.
 */
const projectRoot = path.join(repositoryRoot, 'tests', '.tmp', `measure-${selected.fixture}-${selected.run}`);
await rm(projectRoot, { recursive: true, force: true });
await mkdir(path.dirname(projectRoot), { recursive: true });
await cp(fixture, projectRoot, { recursive: true });

/* The Flow and the Skills under test, replacing what the fixture froze -- the same two swaps
   `probe.mjs` makes, for the same reason: a measurement of yesterday's instructions is not a
   measurement of the working tree. */
const shippedFlow = path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'flows', `${manifest.flow}.yaml`);
await cp(shippedFlow, path.join(projectRoot, 'xforge', 'flows', `${manifest.flow}.yaml`));

const payloadSkills = path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'scaffold', 'skills');
const projectSkills = path.join(projectRoot, 'xforge', 'scaffold', 'skills');
let overlaid = 0;
for (const skill of (await readdir(payloadSkills, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
  if (!existsSync(path.join(projectSkills, skill.name))) continue;
  for (const variant of ['SKILL.md', 'SKILL_cn.md']) {
    const source = path.join(payloadSkills, skill.name, variant);
    const target = path.join(projectSkills, skill.name, variant);
    if (!existsSync(source) || !existsSync(target)) continue;
    const shipped = await readFile(source, 'utf8');
    if (shipped === await readFile(target, 'utf8')) continue;
    await writeFile(target, shipped);
    overlaid += 1;
  }
}

/* Aligns the declared CLI with the one under test and reprojects the overlaid Skills into every
   target. Every fixture pins the CLI of its capture day, and a managed operation refuses on the
   mismatch. The outcome is checked rather than the exit code: `update` reports warnings a fixture
   always carries, its Scaffold being older than the CLI by definition. */
const run = (args) => spawnSync(process.execPath, [cli, '--root', projectRoot, ...args], { encoding: 'utf8' });
const updated = run(['update']);
const compatibility = JSON.parse(run(['state', '--field', 'project.compatibility']).stdout || '{}');
const declared = compatibility.cli
  ? compatibility
  : compatibility.data?.['project.compatibility'] ?? compatibility['project.compatibility'] ?? null;
if (!declared?.cli?.matches) {
  throw new Error(`Identity not aligned: declared ${declared?.cli?.declared}, running ${declared?.cli?.actual}. update said: ${(updated.stdout || updated.stderr || '').slice(0, 400)}`);
}

/*
 * The Change put back at the Stage the fixture claims to be, before its Artifacts are stripped.
 *
 * A fixture is captured at a Stage *boundary*, which is the moment after the transition -- so
 * `solid-propose` claims `stage: propose` and its receipt chain says `design`. Stripping the
 * Propose Artifacts there produces a state no real Change is ever in: parked one Stage ahead of the
 * files it is missing. Four baseline runs met it and split three ways: three took the rework
 * transition back and then forward again, and one wrote the Artifacts from `design` and never
 * transitioned at all. The last one measured a different task, which is a measurement that cannot
 * be compared with anything.
 *
 * `transition repair` is the product's own route for this: it drops one leaf receipt and reverts
 * the Change to the Stage that receipt left. Only a leaf may go, and what was discarded is recorded
 * in the audit chain, so this is not a back door around the receipt chain -- it is the same command
 * a person uses when an Artifact still has to change after a Stage was left.
 */
/*
 * A scalar `--field` prints the bare value, not JSON.
 *
 * `--field project.compatibility` returns an object and parses; `--field ...currentStage` returns
 * `design` followed by a newline, which `JSON.parse` rejects. That is a fourth reply shape on top
 * of the three the envelope already has, and reading it wrongly here cost a run.
 */
const scalarField = (fieldPath) => {
  const raw = (run(['state', '--change', manifest.change, '--field', fieldPath]).stdout ?? '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw.replace(/^"|"$/g, ''); }
};
const currentStage = () => scalarField('change.governance.currentStage');
let rewound = 0;
while (currentStage() !== manifest.stage) {
  const receipt = scalarField('change.governance.transitions.latest.receiptId');
  if (!receipt) throw new Error(`Cannot reach Stage ${manifest.stage}: at ${currentStage()} with no receipt left to drop.`);
  const repaired = run(['transition', 'repair', '--change', manifest.change, '--receipt', receipt]);
  if (repaired.status !== 0) throw new Error(`transition repair failed at ${currentStage()}: ${(repaired.stdout || repaired.stderr).slice(0, 400)}`);
  rewound += 1;
  /* A fixture whose whole chain is wrong would loop; five is far past any legitimate depth. */
  if (rewound > 5) throw new Error(`Rewound five receipts without reaching ${manifest.stage}.`);
}

/* The Stage's own Artifacts are removed, so the Stage has a reason to produce them -- the same
   `prepare` the paid probe runs, from the same module, so both instruments start from one state. */
const casePath = path.join(here, 'cases', `${manifest.stage}.mjs`);
const caseModule = existsSync(casePath) ? await import(casePath) : await import(path.join(here, 'cases', '_generic.mjs'));
await caseModule.prepare?.({ projectRoot, change: manifest.change, repositoryRoot, flow: manifest.flow, stage: manifest.stage });

/*
 * The Change directory is committed, and nothing else is.
 *
 * `-A` was the first attempt and it broke the Verify Stage: the Skill overlay and the reprojection
 * `update` performs touch 182 governance and target-projection paths, and committing those *after*
 * the fixture's delivery commit makes them changes no work package accounts for. `check` then
 * refuses with XFORGE_WORK_PACKAGE_TREE_UNATTRIBUTED and neither required Gate runs — a Stage made
 * unreachable by the instrument rather than by anything under test. The measured run reported
 * exactly that and correctly wrote nothing.
 *
 * Only `xforge/changes` matters here anyway: it is the tree `stage` compares for its digest
 * vouchers, and leaving the rest uncommitted is the state the baseline ran under too.
 *
 * A case may override this with `commitScope: 'all'`, and Apply does. There the delivery head is
 * created *by the run*, so every setup path is an ancestor of it rather than beyond it, and the
 * reasoning above inverts: committing all of it is what keeps the instrument's overlay out of the
 * delivery diff. `cases/apply.mjs` carries the full argument.
 *
 * `stage` vouches for what has not moved since the Stage was entered, and vouching compares commits
 * -- so a dirty tree voids every digest and the whole plan is listed as read. The first after-run
 * measured that: 49KB of working set, spilled to disk by the host, five calls spent reading it back.
 * The product now degrades to a path list rather than emitting something that cannot arrive, and the
 * instrument stops manufacturing the condition: a real project commits at its Stage boundaries, and
 * `transition` says so in its own diagnostic.
 */
const addArgs = caseModule.commitScope === 'all' ? ['add', '-A'] : ['add', '--', 'xforge/changes'];
const staged = spawnSync('git', ['-C', projectRoot, ...addArgs], { encoding: 'utf8' });
if (staged.status === 0) spawnSync('git', ['-C', projectRoot, 'commit', '-q', '--allow-empty', '-m', 'measurement setup'], { encoding: 'utf8' });

/* The frozen CLI this run will use, beside the project and outside the repository's reach. */
const pinnedRoot = `${projectRoot}-cli`;
await rm(pinnedRoot, { recursive: true, force: true });
await mkdir(pinnedRoot, { recursive: true });
/* `dist` alone does not run: the built CLI resolves `yaml` and `fast-glob` from the package's own
   `node_modules`. The whole package is copied, which is what "frozen" has to mean here. */
for (const entry of ['dist', 'schemas', 'node_modules', 'package.json']) {
  await cp(path.join(repositoryRoot, 'xforge', entry), path.join(pinnedRoot, entry), { recursive: true });
}
const pinnedCli = path.join(pinnedRoot, 'dist');

process.stdout.write(`${JSON.stringify({
  projectRoot, cli: path.join(pinnedCli, 'cli.js'), change: manifest.change, flow: manifest.flow, stage: manifest.stage,
  skillsOverlaid: overlaid,
  receiptsRewound: rewound,
  identity: { declared: declared.cli.declared, actual: declared.cli.actual },
}, null, 2)}\n`);
