#!/usr/bin/env node
/*
 * Every name these scripts use, checked against the names they have.
 *
 * `tests/live-engine/*.mjs` is the one body of code here that nothing type-checks and nothing in the
 * static suite imports -- importing `run-matrix.mjs` starts a paid run, so no test can. A name that
 * does not exist therefore survives every gate and surfaces when somebody spends money: four did,
 * one at a time, over four separate runs. `flowDefinition` cost a full solid run. The extraction
 * that split `assert-stopped-at-check.mjs` out of `run-matrix.mjs` left eleven more behind in one
 * go -- three functions reading names that had only ever existed in their old module's scope --
 * and the first paid run of the release died on the first of them before making a single provider
 * call.
 *
 * So: `tsc --checkJs` over those files, reporting only the two diagnostics that mean "this name is
 * not defined". The rest of what `checkJs` says about untyped scripts -- inferred object literals,
 * `ProcessEnv` shapes -- is noise for this purpose, and a check that reports noise is a check
 * people learn to skip.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(repositoryRoot, 'tests', 'live-engine', 'tsconfig.names.json');
const tsc = path.join(repositoryRoot, 'xforge', 'node_modules', '.bin', 'tsc');

const result = spawnSync(tsc, ['-p', project], { cwd: repositoryRoot, encoding: 'utf8' });
if (result.error) {
  console.error(`Could not run tsc at ${tsc}: ${result.error.message}`);
  process.exit(1);
}

/* TS2304 is "Cannot find name 'x'"; TS2552 is the same with a spelling suggestion attached. */
const undefinedNames = `${result.stdout}${result.stderr}`
  .split('\n')
  .filter((line) => /error TS(2304|2552):/.test(line));

if (undefinedNames.length === 0) {
  console.log('Every name tests/live-engine/*.mjs uses is defined.');
  process.exit(0);
}

console.error(`${undefinedNames.length} name(s) used and never defined in tests/live-engine:`);
for (const line of undefinedNames) console.error(`  ${line.trim()}`);
console.error('\nThese throw at run time, and the only thing that runs these files is a paid live run.');
process.exit(1);
