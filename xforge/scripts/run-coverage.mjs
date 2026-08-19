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

const tests = spawnSync(process.execPath, [vitest, 'run', 'test'], {
  cwd: packageRoot,
  env: { ...process.env, XFORGE_TEST_NODE_V8_COVERAGE: rawRoot },
  stdio: 'inherit',
});

if (tests.status !== 0) {
  process.exitCode = tests.status ?? 1;
} else {
  /*
   * `c8 report` merges every subprocess's raw V8 coverage into one in-memory model, so its peak
   * heap scales with the suite, not with the source tree. It crossed the ~2 GB default old-space
   * cap on the macOS runner once the suite reached ~270 tests, and the 4096 cap here once the
   * suite reached ~450 (the tests themselves all passed; only the merge OOMed, plateauing at
   * ~4.05 GB against the cap — a ceiling, not a load problem). Raising the cap for this one child
   * keeps the reporter headroom independent of however Node sizes the default from the runner's
   * RAM. The cap is an upper bound, not a reservation: actual usage stays where the model needs.
   */
  const report = spawnSync(process.execPath, [
    '--max-old-space-size=8192',
    c8,
    'report',
    `--temp-directory=${rawRoot}`,
    '--all',
    '--include=dist/**/*.js',
    '--exclude=dist/**/types.js',
    '--reporter=text',
    '--reporter=json-summary',
    '--reporter=lcov',
    `--reports-dir=${coverageRoot}`,
    '--check-coverage',
    '--statements=78',
    '--branches=65',
    '--functions=80',
    '--lines=78',
  ], { cwd: packageRoot, stdio: 'inherit' });
  process.exitCode = report.status ?? 1;
}

await rm(rawRoot, { recursive: true, force: true });
