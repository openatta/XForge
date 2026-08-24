import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeCliIntegrity } from '../dist/core/identity.js';

/**
 * Refuses a test run whose `dist` no longer matches the lockfile the fixtures are built from.
 *
 * Every test project is a copy of `scaffold/payload`, whose `lock.yaml` pins the CLI's integrity.
 * `loadProject` compares that against the integrity of the `dist` actually running, so editing
 * `xforge/src/**` and rebuilding without re-locking makes every fixture reject every command with
 * XFORGE_LOCK_CLI_MISMATCH -- 308 failures in one observed run, none of them about the change under
 * test, and each one reporting the mismatch as though it were a finding about that test.
 *
 * `npm run relock` is the command that fixes it, and it is easy to skip because `npm run build`
 * finishes cleanly and looks like enough. This says so once, before anything runs, instead of
 * letting the suite say it three hundred times in a costume.
 *
 * Deliberately not part of `build`: `relock` builds, re-locks, and builds again, so the lock is
 * legitimately stale during its first build and a check there would refuse the very command that
 * repairs it.
 */

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const lockPath = path.join(packageRoot, '..', 'scaffold', 'payload', 'xforge', 'lock.yaml');

const lockText = await readFile(lockPath, 'utf8');
const declared = /^\s{2}integrity:\s*(\S+)\s*$/m.exec(lockText.slice(lockText.indexOf('\nxforge:')))?.[1];
const actual = runtimeCliIntegrity();

if (!declared) {
  process.stderr.write(`Cannot read the CLI integrity from ${path.relative(process.cwd(), lockPath)}.\n`);
  process.exitCode = 1;
} else if (declared !== actual) {
  process.stderr.write([
    'The built CLI does not match the lockfile every test fixture is copied from.',
    '',
    `  lockfile  ${declared}`,
    `  dist      ${actual}`,
    '',
    '  Run `npm run relock` from the repository root. `npm run build` alone is not enough:',
    '  it produces a new dist without re-pinning the lock, and every fixture then rejects',
    '  every command with XFORGE_LOCK_CLI_MISMATCH.',
    '',
  ].join('\n'));
  process.exitCode = 1;
} else {
  process.stdout.write('Lockfile matches the built CLI.\n');
}
