import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

/*
 * Development re-lock. scaffold/payload/xforge/lock.yaml pins the exact CLI build (dist hash) and
 * per-resource digests, so any change to src/ or to the scaffold payload invalidates it and every
 * fixture install then fails with XFORGE_LOCK_CLI_MISMATCH. Rebuilding the lock the honest way —
 * running a real `xforge install` over the patched payload — regenerates both the integrity anchor
 * and the per-resource digests. Run after `npm run build` whenever a test batch fails with
 * XFORGE_LOCK_CLI_MISMATCH after code changes.
 */

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
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
  const patched = lock.replace(/(xforge:\n\s+integrity:\s+)sha256:[a-f0-9]{64}/, `$1${integrity}`);
  if (patched === lock) {
    process.stderr.write('Payload lock.yaml does not carry an integrity anchor.\n');
    process.exit(1);
  }
  writeFileSync(path.join(staging, 'xforge', 'lock.yaml'), patched);
  run(process.execPath, [cliPath, 'install'], staging);
  const relocked = readFileSync(path.join(staging, 'xforge', 'lock.yaml'), 'utf8');
  writeFileSync(lockPath, relocked);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

run(process.execPath, [path.join(repoRoot, 'xforge', 'scripts', 'scaffold-integrity.mjs'), scaffoldRoot, '--write'], repoRoot);
process.stdout.write(`Re-locked scaffold/payload/xforge/lock.yaml for integrity ${integrity}.\n`);
