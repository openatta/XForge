#!/usr/bin/env node
// Reports which `xforge` a shell in this directory would actually run, and whether it is
// the one this repository builds. A stale global install shadowing a local build is the
// failure this exists to name: the CLI runs, reports a plausible version, and quietly
// tests something other than the working tree.
//
//   node scripts/doctor-install.mjs [--project <dir>]
//
// Exits 0 when the resolved CLI matches this repository's build, 1 otherwise.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { project: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project') {
      const value = argv[index + 1];
      if (!value) throw new Error('--project needs a directory.');
      options.project = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// `version` is the only command that reports where the running file lives, which is the
// single fact that distinguishes a stale install from a current one.
function probe(command, args, cwd) {
  const output = run(command, [...args, 'version'], cwd);
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    return {
      version: parsed?.data?.version ?? null,
      integrity: parsed?.data?.integrity ?? null,
      executablePath: parsed?.data?.executablePath ?? null,
      commit: parsed?.data?.buildIdentity?.commit ?? null,
    };
  } catch {
    return null;
  }
}

function repositoryVersion() {
  return JSON.parse(readFileSync(path.join(repositoryRoot, 'xforge', 'package.json'), 'utf8')).version;
}

function main() {
  const { project } = parseArgs(process.argv.slice(2));
  const expectedVersion = repositoryVersion();
  const builtCli = path.join(repositoryRoot, 'xforge', 'dist', 'cli.js');
  const problems = [];

  process.stdout.write(`XForge install doctor\n`);
  process.stdout.write(`  repository:   ${repositoryRoot}\n`);
  process.stdout.write(`  version here: ${expectedVersion}\n`);
  process.stdout.write(`  probing from: ${project}\n\n`);

  if (!existsSync(builtCli)) {
    problems.push(`No build at ${builtCli} — run \`npm run build\` (or \`npm run relock\` after editing the scaffold).`);
  }

  // Every way a command could resolve, in the order a shell would find them.
  const candidates = [
    { label: 'xforge (PATH)', command: 'xforge', args: [] },
    { label: 'npx --no-install xforge (project-local)', command: 'npx', args: ['--no-install', 'xforge'] },
  ];

  // The working tree's own build is the reference. Comparing versions alone is not enough:
  // an install built from an earlier commit of the same unreleased version reports a
  // matching version string while running different code.
  const reference = existsSync(builtCli) ? probe(process.execPath, [builtCli], repositoryRoot) : null;
  if (reference) {
    process.stdout.write(`  built here:\n`);
    process.stdout.write(`      version   ${reference.version}\n`);
    process.stdout.write(`      commit    ${reference.commit ?? 'unknown'}\n`);
    process.stdout.write(`      integrity ${reference.integrity ?? 'unknown'}\n\n`);
  }

  let pathEntry = null;
  for (const candidate of candidates) {
    const result = probe(candidate.command, candidate.args, project);
    if (!result) {
      process.stdout.write(`  ${candidate.label}: not resolvable\n`);
      continue;
    }
    if (candidate.command === 'xforge') pathEntry = result;
    process.stdout.write(`  ${candidate.label}:\n`);
    process.stdout.write(`      version   ${result.version}\n`);
    process.stdout.write(`      file      ${result.executablePath ?? 'unknown (pre-0.7.12 build)'}\n`);
    process.stdout.write(`      commit    ${result.commit ?? 'unknown'}\n`);
    process.stdout.write(`      integrity ${result.integrity ?? 'unknown'}\n`);
    if (result.version !== expectedVersion) {
      problems.push(
        `${candidate.label} reports ${result.version}, but this repository is ${expectedVersion}. ` +
          `It resolves to ${result.executablePath ?? 'an unknown file'}.`,
      );
    } else if (reference && result.integrity !== reference.integrity) {
      // Same version, different scaffold: the stale-install case that a version check misses.
      problems.push(
        `${candidate.label} reports version ${result.version} like this repository, but a different scaffold ` +
          `(${result.integrity ?? 'unknown'} vs ${reference.integrity}). It was built from commit ` +
          `${result.commit ?? 'unknown'}, not ${reference.commit ?? 'unknown'} — it is stale.`,
      );
    }
  }

  if (!pathEntry) {
    process.stdout.write(`\nNo \`xforge\` on PATH.\n`);
    process.stdout.write(`Install it with: npm install -g @xforge/cli@${expectedVersion}\n`);
    process.stdout.write(`To test the working tree instead of a published version, live-engine runs\n`);
    process.stdout.write(`must pass --cli-source local; they prepend the sample project's node_modules/.bin to PATH.\n`);
  }

  if (problems.length === 0) {
    process.stdout.write(`\nOK — the resolved CLI matches this repository.\n`);
    return 0;
  }

  process.stdout.write(`\n${problems.length} problem(s):\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.stdout.write(`\nA stale install is fixed by reinstalling from this tree, not by editing the manifest:\n`);
  process.stdout.write(`  npm run build && npm install -g ${path.join(repositoryRoot, 'xforge')}\n`);
  process.stdout.write(`or by removing it so live-engine runs use their own isolated install:\n`);
  process.stdout.write(`  npm uninstall -g @xforge/cli\n`);
  return 1;
}

process.exit(main());
