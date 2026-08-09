#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const packageJson = JSON.parse(readFileSync('xforge/package.json', 'utf8'));
const version = packageJson.version;
const packedRoot = mkdtempSync(path.join(tmpdir(), 'xforge-packed-artifact-'));
const consumerRoot = mkdtempSync(path.join(tmpdir(), 'xforge-package-consumer-'));
const projectRoot = mkdtempSync(path.join(tmpdir(), 'xforge-package-project-'));
const ownsNpmCache = !process.env.XFORGE_PACKAGE_NPM_CACHE;
const npmCache = process.env.XFORGE_PACKAGE_NPM_CACHE
  ?? mkdtempSync(path.join(tmpdir(), 'xforge-package-npm-'));

try {
  const builtCli = path.resolve('xforge/dist/cli.js');
  const builtVersion = JSON.parse(run(process.execPath, [builtCli, 'version'], true));
  assert(builtVersion?.ok === true, 'Built CLI version command failed.');

  const packed = JSON.parse(run('npm', [
    'pack', './xforge', '--json', '--ignore-scripts', '--pack-destination', packedRoot,
  ], true));
  const tarball = path.join(packedRoot, packed[0]?.filename ?? 'missing.tgz');
  assert(existsSync(tarball), 'npm pack did not create the expected tarball.');

  writeFileSync(path.join(consumerRoot, 'package.json'), `${JSON.stringify({ name: 'xforge-package-smoke', private: true }, null, 2)}\n`);
  run('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', tarball,
  ], false, consumerRoot);

  const installedCli = path.join(consumerRoot, 'node_modules', '@xforge', 'cli', 'dist', 'cli.js');
  assert(existsSync(installedCli), 'Installed tarball is missing dist/cli.js.');
  const installedVersion = JSON.parse(run(process.execPath, [installedCli, 'version'], true, consumerRoot));
  assert(installedVersion?.ok === true, 'Installed tarball version command failed.');
  assert(installedVersion?.data?.version === version, 'Installed tarball reports the wrong version.');
  assert(installedVersion?.data?.integrity === builtVersion?.data?.integrity, 'Installed tarball integrity differs from the built CLI.');

  const installedInit = JSON.parse(run(process.execPath, [installedCli, '--root', projectRoot, 'init', '--dry-run'], true, consumerRoot));
  assert(installedInit?.ok === true && installedInit?.command === 'init', 'Installed tarball init --dry-run failed.');
  assert(!existsSync(path.join(projectRoot, 'xforge')), 'Installed tarball init --dry-run wrote project files.');
  process.stdout.write(`Package smoke passed for @xforge/cli@${version}.\n`);
} finally {
  rmSync(packedRoot, { recursive: true, force: true });
  rmSync(consumerRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
  if (ownsNpmCache) rmSync(npmCache, { recursive: true, force: true });
}

function run(command, arguments_, capture = false, cwd = undefined) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, npm_config_cache: npmCache },
  });
  if (result.status !== 0) throw new Error(`Command failed: ${command} ${arguments_.join(' ')}\n${result.stdout || result.stderr}`);
  return capture ? result.stdout : '';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
