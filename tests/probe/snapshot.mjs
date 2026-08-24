import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';

/**
 * Freezes a live project as the starting point for one Stage.
 *
 * A full Flow run costs about sixteen dollars and an hour, and most of that is spent re-reaching a
 * Stage that a previous run already reached. Snapshotting the project at that point turns a cost
 * already paid into a fixture, so verifying a change to one Stage costs one model call instead of
 * the whole graph.
 *
 * The recorded `flowVersion` and `flowDigest` are what stop this becoming another silent drift.
 * A fixture is only valid against the Flow it was produced under; edit that Flow and the fixture
 * describes a Change nobody would write today. `probe.mjs` refuses on a mismatch rather than
 * running against it, because a probe that quietly measures the wrong thing is worse than no probe.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(here, 'fixtures');

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [key, value] = [argv[index], argv[index + 1]];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Expected --key value pairs.');
    parsed[key.slice(2)] = value;
  }
  for (const required of ['from', 'flow', 'stage', 'change']) {
    if (!parsed[required]) throw new Error(`--${required} is required.`);
  }
  return parsed;
}

const selected = options(process.argv.slice(2));
const source = path.resolve(selected.from);
if (!existsSync(source)) throw new Error(`No project at ${source}.`);

const flowPath = path.join(source, 'xforge', 'flows', `${selected.flow}.yaml`);
const flowText = await readFile(flowPath, 'utf8');
const flow = parse(flowText);

const { createHash } = await import('node:crypto');
const target = path.join(fixturesRoot, `${selected.flow}-${selected.stage}`);
await rm(target, { recursive: true, force: true });
await mkdir(fixturesRoot, { recursive: true });
await cp(source, target, { recursive: true });

const manifest = {
  flow: selected.flow,
  stage: selected.stage,
  change: selected.change,
  /* Both, because a version that did not move is exactly how a Flow edit goes unnoticed. */
  flowVersion: String(flow.metadata?.version ?? 'unknown'),
  flowDigest: createHash('sha256').update(flowText).digest('hex'),
  capturedAt: new Date().toISOString(),
  source: path.relative(path.join(here, '..', '..'), source),
};
await writeFile(path.join(target, 'probe-fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, fixture: path.relative(process.cwd(), target), ...manifest }, null, 2)}\n`);
