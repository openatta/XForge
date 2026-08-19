#!/usr/bin/env node
/*
 * Sweeps the scratch a test or release run leaves behind.
 *
 * Two different leaks feed this. Scripts that mint a temp directory and exit through an error path
 * skip their own cleanup — `release-check.mjs` did that thirty times over — and a vitest run killed
 * mid-flight never reaches the `afterAll` in `xforge/test/helpers.ts`, stranding its fixtures. Both
 * land in the OS temp directory under an `xforge-` prefix, and neither run knows about the other's
 * remains, so nothing was ever positioned to remove them. Together they had reached 966 MB and
 * filled the disk.
 *
 *   node scripts/clean-tmp.mjs             # stale scratch, and regenerable live-engine scratch
 *   node scripts/clean-tmp.mjs --all       # ignore the age guard; remove tests/.tmp entirely
 *   node scripts/clean-tmp.mjs --quiet     # only report when something was actually freed
 *
 * Wired to `posttest` so an ordinary test run pays off the previous crashed one.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.includes('--all');
const quiet = process.argv.includes('--quiet');
for (const argument of process.argv.slice(2)) {
  if (!['--all', '--quiet'].includes(argument)) {
    process.stderr.write(`Unknown option: ${argument}\n`);
    process.exit(1);
  }
}

/*
 * A directory younger than this may belong to a run happening right now — this script is wired to
 * `posttest`, and two suites can be in flight at once. Sweeping the previous run's remains rather
 * than the current one's is the whole design: nothing is ever deleted out from under a live run,
 * and anything missed is collected by the next invocation.
 */
const MINIMUM_AGE_MS = 10 * 60 * 1000;
const now = Date.now();
let freedBytes = 0;
const removed = [];

function sizeOf(target) {
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let entry;
    try {
      entry = statSync(current);
    } catch { continue; }
    if (!entry.isDirectory()) { total += entry.size; continue; }
    let children = [];
    try {
      children = readdirSync(current);
    } catch { continue; }
    for (const child of children) stack.push(path.join(current, child));
  }
  return total;
}

function remove(target, label) {
  if (!existsSync(target)) return;
  const bytes = sizeOf(target);
  rmSync(target, { recursive: true, force: true });
  freedBytes += bytes;
  removed.push(`${label} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}

// 1. Scratch stranded in the OS temp directory by a run that did not clean up after itself.
const systemTemp = tmpdir();
let entries = [];
try {
  entries = readdirSync(systemTemp);
} catch { /* nothing to sweep */ }
for (const name of entries) {
  if (!name.startsWith('xforge-')) continue;
  const target = path.join(systemTemp, name);
  let stats;
  try {
    stats = statSync(target);
  } catch { continue; }
  if (!all && now - stats.mtimeMs < MINIMUM_AGE_MS) continue;
  remove(target, name);
}

// 2. Regenerable live-engine scratch. The isolated project directories and `live-engine-results`
//    are deliberately spared, and now for the only reason left: a live run costs real money and
//    calls a real model, and its project tree plus its timeline are the entire record of what
//    happened. Nothing packages them afterwards any more, so sweeping them is not "cleanup before
//    the recording" — it is the destruction of the run itself. `--all` is the explicit opt-in.
const liveEngineTemp = path.join(repositoryRoot, 'tests', '.tmp');
if (all) {
  remove(liveEngineTemp, 'tests/.tmp');
} else if (existsSync(liveEngineTemp)) {
  for (const name of readdirSync(liveEngineTemp)) {
    const target = path.join(liveEngineTemp, name);
    // Per-run logs, which the results directory already summarizes.
    if (name.endsWith('.log')) remove(target, `tests/.tmp/${name}`);
  }
  // npm-pack keeps one tarball per version forever; only the current one can be installed from.
  const packRoot = path.join(liveEngineTemp, 'live-engine-npm-pack');
  if (existsSync(packRoot)) {
    let version = null;
    try {
      version = JSON.parse(readFileSync(path.join(repositoryRoot, 'xforge', 'package.json'), 'utf8')).version;
    } catch { /* leave the tarballs alone if the version cannot be read */ }
    if (version) {
      for (const name of readdirSync(packRoot)) {
        if (name.endsWith('.tgz') && !name.includes(version)) remove(path.join(packRoot, name), `stale tarball ${name}`);
      }
    }
  }
}

if (removed.length === 0) {
  if (!quiet) process.stdout.write('Nothing to clean.\n');
  process.exit(0);
}
if (quiet) {
  process.stdout.write(`Cleaned ${removed.length} stale scratch entries, freeing ${(freedBytes / 1024 / 1024).toFixed(1)} MB.\n`);
} else {
  process.stdout.write(`Freed ${(freedBytes / 1024 / 1024).toFixed(1)} MB:\n`);
  for (const entry of removed) process.stdout.write(`  - ${entry}\n`);
}
