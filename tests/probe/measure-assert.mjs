import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The same verdict the paid probe reaches, over a project some other agent drove.
 *
 * Reusing `cases/<stage>.mjs` rather than writing a second set of assertions is the whole point: an
 * instrument that agreed with its own copy of the rules and disagreed with the paid one would make
 * the two sets of numbers incomparable, which is the only thing they are for.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.join(here, '..', '..');

const parsed = {};
for (let index = 2; index < process.argv.length; index += 2) parsed[process.argv[index].slice(2)] = process.argv[index + 1];
if (!parsed.fixture || !parsed.project) throw new Error('--fixture and --project are required.');

const manifest = JSON.parse(await readFile(path.join(here, 'fixtures', parsed.fixture, 'probe-fixture.json'), 'utf8'));
const casePath = path.join(here, 'cases', `${manifest.stage}.mjs`);
const caseModule = existsSync(casePath) ? await import(casePath) : await import(path.join(here, 'cases', '_generic.mjs'));
const checks = await caseModule.assert({
  projectRoot: parsed.project, change: manifest.change, repositoryRoot, flow: manifest.flow, stage: manifest.stage,
});
const failures = checks.filter((check) => !check.ok);
process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, fixture: parsed.fixture, stage: manifest.stage, checks }, null, 2)}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
