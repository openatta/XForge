#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const requireTag = process.argv.includes('--require-tag');
const npmCache = process.env.XFORGE_RELEASE_NPM_CACHE
  ?? mkdtempSync(path.join(tmpdir(), 'xforge-release-npm-'));
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
  ['xforge/scripts/build-scaffold.mjs', `xforge-scaffold-${version}.tar.gz`],
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
run(process.execPath, ['scripts/privacy-check.mjs', '--include', 'xforge/dist']);

const versionEnvelope = JSON.parse(run(process.execPath, ['xforge/dist/cli.js', 'version'], true));
const builtIntegrity = versionEnvelope?.data?.integrity;
const scaffoldLock = readFileSync('scaffold/payload/xforge/lock.yaml', 'utf8');
assert(scaffoldLock.includes(`integrity: ${builtIntegrity}`), 'Scaffold lock CLI integrity does not match the built package.');

const packResult = JSON.parse(run('npm', ['pack', './xforge', '--dry-run', '--json', '--ignore-scripts'], true));
const packed = packResult[0];
assert(packed?.name === '@xforge/cli', 'Packed npm name is not @xforge/cli.');
assert(packed?.version === version, 'Packed npm version is stale.');
const packedFiles = new Set((packed?.files ?? []).map((file) => file.path));
for (const required of ['README.md', 'dist/LICENSE', 'dist/NOTICE', 'dist/cli.js', 'package.json']) {
  assert(packedFiles.has(required), `Packed npm artifact is missing ${required}.`);
}
for (const file of packedFiles) {
  assert(!file.startsWith('src/'), `Packed npm artifact unexpectedly includes ${file}.`);
  assert(!file.startsWith('test/'), `Packed npm artifact unexpectedly includes ${file}.`);
}

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

function run(command, arguments_, capture = false) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: { ...process.env, npm_config_cache: npmCache },
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
