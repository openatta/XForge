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
  const report = spawnSync(process.execPath, [
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
