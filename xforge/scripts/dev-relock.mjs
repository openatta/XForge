import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/*
 * Development re-lock. scaffold/payload/xforge/lock.yaml pins the exact CLI build (the
 * `xforge.integrity` hash over dist/ + schemas/ + package.json) and a content digest per selected
 * resource, so any change to src/ or to the scaffold payload invalidates it and every fixture
 * install then fails with a confusing XFORGE_LOCK_* error unrelated to what was actually edited.
 * Rebuilding it the honest way — running a real `xforge install` over a staged copy of the patched
 * payload — regenerates the integrity anchor and recomputes every per-resource digest.
 *
 * Invoke this as `npm run relock`, not directly: the payload edit that made a relock necessary also
 * makes `scaffold/files.sha256` stale, and the build's own copy-scaffold step verifies that digest
 * before this script would ever run. The npm script refreshes files.sha256 first, then builds, then
 * relocks; `npm run build && node dev-relock.mjs` by hand fails on that ordering.
 */

/*
 * `fileURLToPath`, not `new URL(...).pathname` + `path.resolve`: a `file://` URL's `.pathname` on
 * Windows keeps a leading slash before the drive letter (`/D:/...`), which `path.resolve` does not
 * strip — it prepends the cwd's own drive instead, producing a broken `D:\D:\...` path. `fileURLToPath`
 * handles this (and URL-encoding) correctly on every platform.
 */
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scaffoldRoot = path.join(repoRoot, 'scaffold');
const lockPath = path.join(scaffoldRoot, 'payload', 'xforge', 'lock.yaml');
const cliPath = path.join(repoRoot, 'xforge', 'dist', 'cli.js');

function run(command, args, cwd, parseJson = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(`${command} ${args.join(' ')} failed: ${result.stderr}\n`);
    process.exit(1);
  }
  return parseJson ? JSON.parse(result.stdout) : result.stdout;
}

const integrity = run(process.execPath, [cliPath, 'version'], repoRoot, true)?.data?.integrity;
if (!/^sha256:[a-f0-9]{64}$/.test(integrity ?? '')) {
  process.stderr.write('Unable to calculate the built CLI integrity. Run `npm run build` first.\n');
  process.exit(1);
}

const staging = mkdtempSync(path.join(tmpdir(), 'xforge-relock-'));
try {
  cpSync(path.join(scaffoldRoot, 'payload'), staging, { recursive: true });
  const lock = readFileSync(path.join(staging, 'xforge', 'lock.yaml'), 'utf8');
  /* The integrity anchor has to be patched before `install` runs: install verifies the lock's
     declared CLI build against the running one, so a stale anchor would refuse the very run that
     is meant to refresh it. */
  const anchor = /(xforge:\n\s+integrity:\s+)sha256:[a-f0-9]{64}/;
  /* Test for the anchor itself rather than inferring from "the string changed": when the payload
     lock is already at the current integrity (a re-run with no source change), the substitution is
     a no-op and an equality check would wrongly report a missing anchor. */
  if (!anchor.test(lock)) {
    process.stderr.write('Payload lock.yaml does not carry an integrity anchor.\n');
    process.exit(1);
  }
  const patched = lock.replace(anchor, `$1${integrity}`);
  writeFileSync(path.join(staging, 'xforge', 'lock.yaml'), patched);
  run(process.execPath, [cliPath, 'install'], staging);
  writeFileSync(lockPath, readFileSync(path.join(staging, 'xforge', 'lock.yaml'), 'utf8'));
} finally {
  rmSync(staging, { recursive: true, force: true });
}

run(process.execPath, [path.join(repoRoot, 'xforge', 'scripts', 'scaffold-integrity.mjs'), scaffoldRoot, '--write'], repoRoot);
process.stdout.write(`Re-locked scaffold/payload/xforge/lock.yaml for integrity ${integrity}.\n`);
