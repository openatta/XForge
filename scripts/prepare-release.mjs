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

const versionedTextFiles = [
  'AGENT_INSTALL.md',
  'README.md',
  'docs/README.md',
  'docs/TEST_DESIGN.md',
  'docs/XFORGE_PRODUCT_SPEC.md',
  'docs/cli-tool-design.md',
  'docs/cli-tool-usage.md',
  'docs/file-protocol.md',
  'docs/sub-agent-system-design.md',
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
