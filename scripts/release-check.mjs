#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
