#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const nextVersion = process.argv[2];
if (!nextVersion || process.argv.length !== 3) {
  fail('Usage: npm run release:prepare -- <major.minor.patch[-prerelease]>');
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(nextVersion)) fail('The release version is not valid SemVer.');
if (git(['status', '--porcelain']).trim()) fail('The worktree must be clean before release preparation.');

const rootPackage = readJson('package.json');
const cliPackage = readJson('xforge/package.json');
const currentVersion = cliPackage.version;
if (rootPackage.version !== currentVersion) fail('Root and CLI package versions are already inconsistent.');
if (compareVersions(nextVersion, currentVersion) <= 0) fail('The new version must be greater than the current version.');

run(process.execPath, ['scripts/privacy-check.mjs', '--check-next-commit']);

rootPackage.version = nextVersion;
writeJson('package.json', rootPackage);
cliPackage.version = nextVersion;
writeJson('xforge/package.json', cliPackage);

const lock = readJson('xforge/package-lock.json');
lock.version = nextVersion;
if (lock.packages?.['']) lock.packages[''].version = nextVersion;
writeJson('xforge/package-lock.json', lock);

/*
 * Every tracked file that states the CLI version in prose or fixture data.
 *
 * An allowlist rather than a scan, because rewriting a version string is not something to do to a
 * file nobody nominated — but an allowlist alone rots, and did: the docs restructure removed six of
 * the entries here and added five documents that state the version, so the next release would have
 * thrown ENOENT partway through the rewrite and, had it survived that, shipped five documents still
 * naming the previous version. `assertNoStaleVersion` below is what stops the list going quietly
 * out of date again.
 */
const versionedTextFiles = [
  'AGENT_INSTALL.md',
  'README.md',
  'docs/cli-tool-usage.md',
  'docs/concepts-and-architecture.md',
  'docs/index.md',
  'docs/repository-layout.md',
  'docs/sub-agent-design.md',
  'scaffold/payload/xforge/lock.yaml',
  'scaffold/payload/xforge/manifest.yaml',
  'scaffold/scaffold.yaml',
  'tests/product-validation.test.ts',
  'xforge/README.md',
  'xforge/src/constants.ts',
  'xforge/test/integration/cli-protocol.test.ts',
  'xforge/test/integration/init.test.ts',
  'xforge/test/integration/projection-lifecycle.test.ts',
];
for (const file of versionedTextFiles) replaceVersion(file, currentVersion, nextVersion);
assertNoStaleVersion(currentVersion);

run(process.execPath, ['xforge/scripts/scaffold-integrity.mjs', 'scaffold', '--write']);
run('npm', ['--prefix', 'xforge', 'run', 'build']);
const versionEnvelope = JSON.parse(run(process.execPath, ['xforge/dist/cli.js', 'version'], true));
const integrity = versionEnvelope?.data?.integrity;
if (!/^sha256:[a-f0-9]{64}$/.test(integrity ?? '')) fail('Unable to calculate the built CLI integrity.');

const scaffoldLockPath = 'scaffold/payload/xforge/lock.yaml';
const scaffoldLock = readFileSync(scaffoldLockPath, 'utf8').replace(
  /(xforge:\n\s+integrity:\s+)sha256:[a-f0-9]{64}/,
  `$1${integrity}`,
);
writeFileSync(scaffoldLockPath, scaffoldLock);
run(process.execPath, ['xforge/scripts/scaffold-integrity.mjs', 'scaffold', '--write']);
run(process.execPath, ['scripts/privacy-check.mjs']);

process.stdout.write(`Prepared XForge ${nextVersion}. Review the diff, run npm run release:check, then commit and tag v${nextVersion}.\n`);

/**
 * Refuses a prepared release that still names the previous version anywhere in the tracked tree.
 *
 * The allowlist above is the whole of what gets rewritten, so a file that states the version and is
 * not on it goes stale silently — which is worse than the ENOENT a removed entry throws, because
 * nothing reports it and the wrong number ships. Asking Git what is left is cheap and needs no
 * second list to maintain: add the file to `versionedTextFiles`, or, if it names an older version
 * on purpose (a migration note, a historical example), say so here.
 */
function assertNoStaleVersion(previousVersion) {
  /* `git grep` exits 1 when it matches nothing, and `git()` throws on a non-zero exit — so the
     clean case is an exception here, not a result. Spawned directly to read the status instead. */
  const search = spawnSync('git', ['grep', '--name-only', '--fixed-strings', previousVersion], { encoding: 'utf8' });
  if (search.status !== 0 && search.status !== 1) fail(`Unable to search the tree for ${previousVersion}: ${search.stderr || search.error?.message}`);
  const remaining = (search.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    /*
     * Recorded envelopes are re-recorded, not rewritten.
     *
     * A golden under `test/fixtures/golden/` is a byte-for-byte capture of what the CLI printed, and
     * several of them carry the version because the envelope does. Substituting the string into them
     * would be forging a recording; they are refreshed by running the suite with
     * `XFORGE_UPDATE_GOLDEN=1` against the built CLI, which is the only way the capture stays a
     * capture.
     *
     * Left to the suite rather than policed here, because the suite already policies it: a golden
     * still naming the previous version fails the moment anything runs, and `npm run verify` is on
     * the release path. A guard that duplicated that would add a second thing to keep in step with
     * the first.
     */
    .filter((file) => !file.startsWith('xforge/test/fixtures/golden/'));
  if (remaining.length > 0) {
    fail(`These tracked files still name ${previousVersion} after the rewrite: ${remaining.join(', ')}. Add each to versionedTextFiles, or record here why it keeps the old version.`);
  }
}

function replaceVersion(file, from, to) {
  const content = readFileSync(file, 'utf8');
  if (!content.includes(from)) fail(`${file} does not contain the expected current version ${from}.`);
  writeFileSync(file, content.replaceAll(from, to));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function compareVersions(left, right) {
  const parse = (value) => {
    const [core, prerelease = ''] = value.split('-', 2);
    return { core: core.split('.').map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

function git(arguments_) {
  return execFileSync('git', arguments_, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function run(command, arguments_, capture = false) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.status !== 0) fail(`Command failed: ${command} ${arguments_.join(' ')}`);
  return capture ? result.stdout : '';
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
