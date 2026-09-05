import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';

/**
 * Freezes a project as the starting point for one Stage.
 *
 * A full Flow run costs about sixteen dollars and an hour, and most of that is spent re-reaching a
 * Stage that a previous run already reached. Snapshotting the project at that point turns a cost
 * already paid into a fixture, so verifying a change to one Stage costs one model call instead of
 * the whole graph.
 *
 * Two sources, and the second is the one that scales.
 *
 * `--from <dir>` freezes a live working tree, which only works while a run is sitting at the Stage
 * you want. That is a narrow window: a run that finishes archives its Change, so by the time anyone
 * thinks to harvest a fixture the intermediate states are gone from the tree. They are not gone from
 * history -- `run-matrix.mjs` commits at every Stage boundary ("Live engine stage complete:
 * <flow>:<stage>"), so a completed run already contains every Stage's state as a commit.
 *
 * `--at <ref>` reads one of those. Every paid matrix run is therefore a whole fixture library that
 * can be collected afterwards, at any time, for nothing. `--list true` prints what a given run has.
 *
 * The recorded `flowVersion` and `flowDigest` are what stop this becoming another silent drift.
 * A fixture is only valid against the Flow it was produced under; edit that Flow and the fixture
 * describes a Change nobody would write today. `probe.mjs` refuses on a mismatch rather than
 * running against it, because a probe that quietly measures the wrong thing is worse than no probe.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(here, 'fixtures');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

/* A commit that predates a path simply does not have it, which is an answer, not a failure. */
function gitTry(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [key, value] = [argv[index], argv[index + 1]];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Expected --key value pairs.');
    parsed[key.slice(2)] = value;
  }
  if (!parsed.from) throw new Error('--from is required.');
  if (parsed.list === 'true') return parsed;
  for (const required of ['flow', 'stage', 'change']) {
    if (!parsed[required]) throw new Error(`--${required} is required.`);
  }
  return parsed;
}

const selected = options(process.argv.slice(2));
const source = path.resolve(selected.from);
if (!existsSync(source)) throw new Error(`No project at ${source}.`);

/*
 * What a finished run still holds, listed by the Stage each commit *stands in* rather than by the
 * commit subjects.
 *
 * The subjects are the trap. A run commits "Live engine stage complete: solid:check" when the check
 * Stage finishes, and reading that as "the check fixture" is off by one Stage in one direction and,
 * worse, off by an approval in the other. The Agent self-transitions at the end of its Stage, so
 * that commit usually already stands in the *next* Stage; but where a Flow requires a human approval
 * between them -- solid's check -> apply -- the transition is a separate commit later, and the
 * stage-complete commit still stands in check with the approval pending. A fixture frozen there
 * cannot enter the Stage it claims to be: an Agent given the apply prompt spends its whole run
 * against an approval it has no authority to grant, and the probe reports a failed check that says
 * nothing about the change under test. That cost a measured $2.98 and one wasted probe.
 *
 * So the Stage is read from the Change's own transition receipts -- the highest sequence wins --
 * which is the same answer `xforge stage` would give, without provisioning a CLI to ask.
 *
 * Default to the earliest commit standing in the Stage you want: that is the point after the Change
 * entered it and before its Artifacts were written, and later commits at the same Stage already hold
 * the work. The exception is a scenario that injects an event mid-Stage -- an upstream requirement
 * edit, an owner answering findings -- which the Stage was meant to face. The subjects are printed
 * so that choice stays the operator's; they are just not what the Stage is read from.
 */
if (selected.list === 'true') {
  const changeAt = (commit) => {
    const roots = selected.change
      ? [selected.change]
      : gitTry(['ls-tree', '--name-only', `${commit}:xforge/changes`], source).split('\n').filter(Boolean);
    for (const change of roots) {
      const base = `xforge/changes/${change.replace(/\/$/, '')}/evidence/receipts/transitions`;
      /* Zero-padded sequence filenames, so the lexicographic last is the latest Transition. */
      const receipts = gitTry(['ls-tree', '--name-only', `${commit}:${base}`], source).split('\n').filter(Boolean).sort();
      const latest = receipts.at(-1);
      if (!latest) continue;
      try {
        return { change: change.replace(/\/$/, ''), stage: JSON.parse(gitTry(['show', `${commit}:${base}/${latest}`], source)).to };
      } catch { /* Not a receipt this tool understands; fall through to the next Change. */ }
    }
    return { change: roots[0]?.replace(/\/$/, '') ?? null, stage: null };
  };

  const log = git(['log', '--format=%H%x09%s'], source).trim();
  const rows = log ? log.split('\n').map((line) => {
    const [commit, subject] = line.split('\t');
    return { commit, ref: commit.slice(0, 12), ...changeAt(commit), subject };
  }) : [];
  process.stdout.write(`${JSON.stringify({
    ok: true,
    source: path.relative(process.cwd(), source),
    note: 'Freeze from the earliest commit standing in the Stage you want -- later ones already hold its work, and a "stage complete: X" subject usually already stands in the Stage after X. Prefer a later commit only to keep a scenario event the Stage was meant to face.',
    available: rows,
  }, null, 2)}\n`);
  process.exit(0);
}

const target = path.join(fixturesRoot, selected.name ?? `${selected.flow}-${selected.stage}`);
await rm(target, { recursive: true, force: true });
await mkdir(fixturesRoot, { recursive: true });

if (selected.at) {
  /* A clone rather than a copy-then-reset: the fixture needs real history, because receipts already
     in it name the commits they were bound to and a probe run writes more on top. */
  git(['clone', '--no-hardlinks', '--quiet', source, target]);
  git(['checkout', '--quiet', '-B', 'probe', selected.at], target);
  /*
   * The installation record, which git cannot supply and the fixture is not a project without.
   *
   * `xforge/.state.json` is ignored on purpose -- it is a rebuildable digest cache, and tracking it
   * turns an ordinary two-branch merge into a hard stop, because a conflicted copy is no longer
   * JSON and `state`, `install`, `sync` and `update` all refuse at the first read. So a fixture
   * materialised from history has every authored file and no record that anything was installed.
   *
   * `probe.mjs` then runs `xforge update` to move the fixture's declared identity onto the CLI it
   * provisioned, and `update` refuses with `XFORGE_NOT_INSTALLED` because that record is missing.
   * The lock keeps the integrity of whatever build captured the fixture, every later command fails
   * `XFORGE_LOCK_CLI_MISMATCH`, and `install` -- the obvious next move -- refuses on that same code.
   * A measured probe met all of it and spent eight of its calls there, which is not what it was
   * paid to measure.
   *
   * Copied from the working tree rather than reconstructed: it describes the install that produced
   * this project, `update` rewrites it immediately, and a cache one run out of date is worth far
   * more here than no cache at all.
   */
  const installRecord = path.join(source, 'xforge', '.state.json');
  if (existsSync(installRecord)) await cp(installRecord, path.join(target, 'xforge', '.state.json'));
} else {
  await cp(source, target, { recursive: true });
}

/* Read the Flow out of the materialised tree, not the live one: with `--at` they are different
   files, and recording the version of a Flow this fixture does not contain would be the drift this
   whole mechanism exists to refuse. */
const flowPath = path.join(target, 'xforge', 'flows', `${selected.flow}.yaml`);
if (!existsSync(flowPath)) throw new Error(`The snapshot has no ${selected.flow}.yaml. Check --flow, and --at if you passed one.`);
const flowText = await readFile(flowPath, 'utf8');
const flow = parse(flowText);

const changeDirectory = path.join(target, 'xforge', 'changes', selected.change);
if (!existsSync(changeDirectory)) {
  throw new Error([
    `The snapshot has no active Change at xforge/changes/${selected.change}.`,
    '  A run that completed archived its Change, so a live tree no longer holds one. Pass --at with',
    '  a Stage-boundary commit instead; `--list true` prints the ones this run recorded.',
  ].join('\n'));
}

const { createHash } = await import('node:crypto');
const manifest = {
  flow: selected.flow,
  stage: selected.stage,
  change: selected.change,
  /* Both, because a version that did not move is exactly how a Flow edit goes unnoticed. */
  flowVersion: String(flow.metadata?.version ?? 'unknown'),
  flowDigest: createHash('sha256').update(flowText).digest('hex'),
  capturedAt: new Date().toISOString(),
  source: path.relative(path.join(here, '..', '..'), source),
  sourceRef: selected.at ? git(['rev-parse', 'HEAD'], target).trim() : null,
};
await writeFile(path.join(target, 'probe-fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, fixture: path.relative(process.cwd(), target), ...manifest }, null, 2)}\n`);
