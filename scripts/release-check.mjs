#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const requireTag = process.argv.includes('--require-tag');
/*
 * Own the cache only when we minted it, exactly as package-smoke.mjs does — a caller that supplies
 * XFORGE_RELEASE_NPM_CACHE is reusing a warm cache across runs and would not thank us for emptying
 * it. Removing it on `exit` rather than at the end of the happy path is the point: this script ends
 * through `fail()` far more often than it reaches the bottom, and every one of those exits used to
 * leave a populated npm cache behind. Thirty of them had accumulated to most of a gigabyte.
 */
const ownsNpmCache = !process.env.XFORGE_RELEASE_NPM_CACHE;
const npmCache = process.env.XFORGE_RELEASE_NPM_CACHE
  ?? mkdtempSync(path.join(tmpdir(), 'xforge-release-npm-'));
process.on('exit', () => {
  if (ownsNpmCache) rmSync(npmCache, { recursive: true, force: true });
});
for (const argument of process.argv.slice(2)) {
  if (argument !== '--require-tag') fail(`Unknown option: ${argument}`);
}

const rootPackage = readJson('package.json');
const cliPackage = readJson('xforge/package.json');
const lock = readJson('xforge/package-lock.json');
const version = cliPackage.version;
const expectedTag = `v${version}`;

assert(rootPackage.version === version, 'Root package version does not match the CLI package.');
assert(lock.version === version, 'CLI package-lock top-level version is stale.');
assert(lock.packages?.['']?.version === version, 'CLI package-lock root package version is stale.');
for (const [file, pattern] of [
  ['xforge/src/constants.ts', `CLI_VERSION = '${version}'`],
  ['scaffold/scaffold.yaml', `version: ${version}`],
  ['scaffold/payload/xforge/manifest.yaml', `version: ${version}`],
  ['scaffold/payload/xforge/lock.yaml', `version: ${version}`],
]) {
  assert(readFileSync(file, 'utf8').includes(pattern), `${file} does not declare ${version}.`);
}

if (requireTag) {
  assert(!git(['status', '--porcelain']).trim(), 'The release worktree is not clean.');
  const head = git(['rev-parse', 'HEAD']).trim();
  const taggedCommit = git(['rev-list', '-n', '1', expectedTag]).trim();
  assert(head === taggedCommit, `${expectedTag} does not point to HEAD.`);
  assertLiveEngineCoversHead(head);
}

/**
 * Refuses to release a build the live scenarios did not actually exercise.
 *
 * Static suites run in the same breath as the release check, so they always describe the commit
 * being released. Live runs do not: they take the better part of an hour, they are started by hand,
 * and their results sit in `tests/.tmp/live-engine-results/` outliving whatever came next. So the
 * ordinary sequence -- run the Flows, decide the release is good, land one more change, move the
 * tag -- silently produces a release nobody has driven a model against.
 *
 * That happened here. Three Flow scenarios validated one commit, a feature landed after them, the
 * tag moved to include it, and the only thing between that and a publish was a person noticing.
 * A check is cheaper than noticing.
 *
 * Every shipped Flow must have a result, each recorded against this exact commit and against a
 * clean tree, because a run over uncommitted work describes no commit at all. Missing results are
 * refused as loudly as stale ones: "we never ran it" and "we ran it against something else" are the
 * same failure from the reader's side.
 */
function assertLiveEngineCoversHead(head) {
  const resultsRoot = 'tests/.tmp/live-engine-results';
  const required = readdirSync('scaffold/payload/xforge/flows')
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.slice(0, -'.yaml'.length))
    .sort();

  const problems = [];
  for (const scenario of required) {
    const file = path.join(resultsRoot, `${scenario}-timeline.json`);
    let timeline;
    try { timeline = JSON.parse(readFileSync(file, 'utf8')); }
    catch { problems.push(`${scenario}: no live-engine result at ${file}`); continue; }
    const built = timeline.testedBuild;
    if (!built?.commit) { problems.push(`${scenario}: its result records no commit, so it cannot be matched to this release`); continue; }
    if (built.dirty) { problems.push(`${scenario}: ran against a dirty worktree, which describes no commit`); continue; }
    if (built.commit !== head) problems.push(`${scenario}: ran against ${built.commit.slice(0, 12)}, released commit is ${head.slice(0, 12)}`);
  }

  assert(problems.length === 0, [
    'The live-engine runs do not cover the commit being released.',
    ...problems.map((line) => `  - ${line}`),
    '',
    '  Re-run the affected scenarios against this commit:',
    ...required.map((scenario) => `    node tests/live-engine/run-matrix.mjs --scenario ${scenario} --cli-source local`),
  ].join('\n'));
}

run(process.execPath, ['scripts/privacy-check.mjs']);
run('npm', ['--prefix', 'xforge', 'run', 'verify']);
run(process.execPath, ['scripts/privacy-check.mjs', '--include', 'xforge/dist', '--include', 'xforge/scaffold']);

const versionEnvelope = JSON.parse(run(process.execPath, ['xforge/dist/cli.js', 'version'], true));
const builtIntegrity = versionEnvelope?.data?.integrity;
const scaffoldLock = readFileSync('scaffold/payload/xforge/lock.yaml', 'utf8');
assert(scaffoldLock.includes(`integrity: ${builtIntegrity}`), 'Scaffold lock CLI integrity does not match the built package.');

const packResult = JSON.parse(run('npm', ['pack', './xforge', '--dry-run', '--json', '--ignore-scripts'], true));
const packed = packResult[0];
assert(packed?.name === '@xforge/cli', 'Packed npm name is not @xforge/cli.');
assert(packed?.version === version, 'Packed npm version is stale.');
const packedFiles = new Set((packed?.files ?? []).map((file) => file.path));
for (const required of ['README.md', 'dist/LICENSE', 'dist/NOTICE', 'dist/cli.js', 'package.json', 'scaffold/scaffold.yaml', 'scaffold/files.sha256', 'scaffold/payload/xforge/manifest.yaml']) {
  assert(packedFiles.has(required), `Packed npm artifact is missing ${required}.`);
}
/*
 * Every payload file the inventory names has to survive packing.
 *
 * `files.sha256` is verified at `init` against the payload as installed, so a file npm drops on the
 * way into the tarball fails every install with XFORGE_BUNDLED_SCAFFOLD_INVALID -- naming
 * `files.sha256` as the problem, which is the one file that is right. It happened: a `.gitignore`
 * added to the payload was silently excluded, because npm applies a payload `.gitignore` as a live
 * ignore list while packing and it had no `!.gitignore` line to exempt itself. No unit test can see
 * that; the defect exists only once the package is built.
 *
 * A named-file list would have missed it too, since the file was new. This compares the inventory
 * with the tarball, so the next one is caught whatever it is called.
 */
const inventory = readFileSync('scaffold/files.sha256', 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => line.split(/\s+/).slice(1).join(' '));
assert(inventory.length > 0, 'Scaffold inventory is empty.');
for (const relative of inventory) {
  assert(packedFiles.has(`scaffold/${relative}`), `Packed npm artifact is missing scaffold/${relative}, which scaffold/files.sha256 lists — every install of this tarball would fail XFORGE_BUNDLED_SCAFFOLD_INVALID.`);
}

for (const file of packedFiles) {
  assert(!file.startsWith('src/'), `Packed npm artifact unexpectedly includes ${file}.`);
  assert(!file.startsWith('test/'), `Packed npm artifact unexpectedly includes ${file}.`);
  // The npm artifact ships compiled output only. `dist/**/*.d.ts` is the compiler's
  // declaration output, not source. One deliberate exception: the Scaffold's
  // `project-context` example script is project-facing template content — init copies
  // it into the user's project to demonstrate declaring a TypeScript script — not the
  // CLI's source, and its digest is chained in lock.yaml. A TypeScript file anywhere
  // else means the source tree is leaking into the published package.
  assert(
    !/\.tsx?$/.test(file)
      || (file.startsWith('dist/') && file.endsWith('.d.ts'))
      || file === 'scaffold/payload/xforge/scripts/project-context/main.ts',
    `Packed npm artifact unexpectedly includes TypeScript ${file}.`,
  );
}

run(process.execPath, ['scripts/package-smoke.mjs']);

process.stdout.write(`Release check passed for @xforge/cli@${version}${requireTag ? ` at ${expectedTag}` : ''}.\n`);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function git(arguments_) {
  try {
    return execFileSync('git', arguments_, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    fail(`Git validation failed for ${arguments_.join(' ')}.`);
  }
}

function run(command, arguments_, capture = false, cwd = undefined) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: { ...process.env, npm_config_cache: npmCache, XFORGE_PACKAGE_NPM_CACHE: npmCache },
  });
  if (result.status !== 0) fail(`Command failed: ${command} ${arguments_.join(' ')}`);
  return capture ? result.stdout : '';
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
