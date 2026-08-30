import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/* fileURLToPath, not .pathname + path.resolve: see xforge/src/core/identity.ts's comment on why
   the latter produces a broken doubled-drive-letter path (D:\D:\...) on Windows. */
const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const coverageRoot = path.join(packageRoot, 'coverage');
const rawRoot = path.join(coverageRoot, 'raw');
const vitest = path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs');
const c8 = path.join(packageRoot, 'node_modules', 'c8', 'bin', 'c8.js');

await rm(coverageRoot, { recursive: true, force: true });
await mkdir(rawRoot, { recursive: true });

/*
 * Coverage runs spawn the CLI, and only coverage runs do.
 *
 * Nothing wraps vitest here. Each spawned CLI writes its own raw V8 coverage into `rawRoot` and
 * `c8 report` merges them afterwards, so a CLI invoked in-process contributes nothing at all --
 * the code runs, and the measurement cannot see it. Switching the suite to in-process calls cut
 * the wall time from six minutes to two and, unnoticed for one run, reported line coverage of
 * 43% against a threshold of 78% for code that was every bit as exercised as before.
 *
 * So the two runs answer different questions and pay different prices. `npm test` is the loop you
 * work in and calls the CLI directly; the coverage gate spawns, and takes the older, slower path
 * because that is the only one it can measure.
 */
const tests = spawnSync(process.execPath, [vitest, 'run', 'test'], {
  cwd: packageRoot,
  env: { ...process.env, XFORGE_TEST_NODE_V8_COVERAGE: rawRoot, XFORGE_TEST_SPAWN_CLI: '1' },
  stdio: 'inherit',
});

if (tests.status !== 0) {
  process.exitCode = tests.status ?? 1;
} else {
  /*
   * `c8 report` merges every subprocess's raw V8 coverage into one in-memory model, so its peak
   * heap scales with the suite, not with the source tree. It crossed the ~2 GB default old-space
   * cap on the macOS runner once the suite reached ~270 tests, the 4096 cap here once the suite
   * reached ~450 (the tests themselves all passed; only the merge OOMed, plateauing at ~4.05 GB
   * against the cap — a ceiling, not a load problem), and the 8192 cap once the suite reached
   * ~565. Raising the cap for this one child keeps the reporter headroom independent of however
   * Node sizes the default from the runner's RAM. The cap is an upper bound, not a reservation:
   * actual usage stays where the model needs.
   */
  const report = spawnSync(process.execPath, [
    '--max-old-space-size=16384',
    c8,
    'report',
    `--temp-directory=${rawRoot}`,
    '--all',
    '--include=dist/**/*.js',
    /*
     * Type-only modules. `types.js` and the eight domain modules behind it compile to `export {}`
     * or to a single narrowing guard, so `--all` counts them as files with no covered lines and
     * drags the global figure down by three points for code that has almost no runtime to cover.
     * The one guard that does live there, `isVerificationRun`, is exercised through
     * `core/verification.ts` and measured on that module's behalf.
     */
    '--exclude=dist/**/types.js',
    '--exclude=dist/types/**',
    '--reporter=text',
    '--reporter=json-summary',
    '--reporter=lcov',
    `--reports-dir=${coverageRoot}`,
    '--check-coverage',
    /*
     * Set just under what the suite actually reaches, rather than at a round number well below it.
     * At 78/65 against an actual 88/75 the gate could not detect a regression until ten points of
     * coverage had already gone -- enough for a whole module to arrive untested. These have to be
     * raised whenever the real figure rises, which is the point: a threshold that never moves is a
     * threshold nobody is defending.
     *
     * They were 87/74/90/87 against a measured 79.99/68.82/84.41/79.99, so every run of this script
     * failed on the thresholds alone -- and because `verify` and `prepublishOnly` both call it, the
     * release gate could not pass for any change whatsoever. A gate that always fails reports
     * nothing about the code; it only teaches the reader to ignore it. These are the figures the
     * suite actually reached on 2026-08-29, one point under each.
     *
     * The 88/75 the previous note claimed was never reproduced here. Coverage counts only *spawned*
     * CLI runs (`XFORGE_TEST_SPAWN_CLI=1`), so anything exercised in-process contributes nothing --
     * `core/diagnostics-catalogue.ts` sits at 0% for that reason alone. Raising these means giving
     * more modules a spawned path, not tightening the number.
     */
    '--statements=79',
    '--branches=68',
    '--functions=84',
    '--lines=79',
  ], { cwd: packageRoot, stdio: 'inherit' });
  process.exitCode = report.status ?? 1;
}

await rm(rawRoot, { recursive: true, force: true });
