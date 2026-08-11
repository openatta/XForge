import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';
import fastGlob from '../../xforge/node_modules/fast-glob/out/index.js';

/**
 * A Flow's `artifacts[].outline` is already the data-driven source of truth for what an
 * artifact must (and must not) cover — see docs/extending-skills-and-flows.md. This checker
 * enforces that data against what the Agent actually produced, instead of relying on prose
 * review, so a live-engine run can fail closed when a Skill pads an artifact with sections the
 * Flow never asked for, or silently drops one it did.
 *
 * `--mode headings` (default, for free-form artifacts like proposal/design/assurance/
 * check-report/clarifications): the produced file's level-2 (`##`) heading set must exactly
 * equal the outline's level-2 heading set.
 *
 * `--mode markers` (for repeating-structure artifacts like delta Specs, where the outline is a
 * template repeated an unknown number of times): every distinct heading/bullet *prefix* used in
 * the outline (e.g. `### Requirement:`, `#### Scenario:`, `- **WHEN**`) must appear at least
 * once in the produced file.
 */

function options(argv) {
  const result = { mode: 'headings' };
  for (let index = 0; index < argv.length; index += 2) result[argv[index].replace(/^--/, '')] = argv[index + 1];
  for (const key of ['root', 'flow', 'artifact', 'file']) if (!result[key]) throw new Error(`--${key} is required.`);
  if (!['headings', 'markers'].includes(result.mode)) throw new Error('--mode must be headings or markers.');
  return result;
}

function headingsOf(text) {
  return [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1].trim());
}

function markerPrefixesOf(text) {
  const prefixes = new Set();
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^(#{2,6}\s+.*?:)/);
    if (heading) { prefixes.add(heading[1].trim()); continue; }
    const bullet = line.match(/^-\s+(\*\*[A-Z]+\*\*)/);
    if (bullet) prefixes.add(bullet[1]);
  }
  return [...prefixes];
}

const selected = options(process.argv.slice(2));
const flowPath = path.join(selected.root, 'xforge', 'flows', `${selected.flow}.yaml`);
const flow = parse(await readFile(flowPath, 'utf8'));
const artifact = flow.artifacts?.find((entry) => entry.id === selected.artifact);
if (!artifact) throw new Error(`Artifact ${selected.artifact} was not found in ${flowPath}.`);
if (!artifact.outline) throw new Error(`Artifact ${selected.artifact} in ${selected.flow} has no outline to check against.`);

let produced;
let matchedFiles;
if (selected.file.includes('*')) {
  matchedFiles = await fastGlob(selected.file, { cwd: selected.root });
  if (matchedFiles.length === 0) throw new Error(`No file matched glob ${selected.file} under ${selected.root}.`);
  produced = (await Promise.all(matchedFiles.map((relative) => readFile(path.join(selected.root, relative), 'utf8')))).join('\n');
} else {
  matchedFiles = [selected.file];
  produced = await readFile(path.join(selected.root, selected.file), 'utf8');
}

let extra = [];
let missing = [];
if (selected.mode === 'headings') {
  const expected = headingsOf(artifact.outline);
  if (expected.length === 0) throw new Error(`Outline for ${selected.artifact} has no level-2 headings; use --mode markers instead.`);
  const actual = headingsOf(produced);
  extra = actual.filter((heading) => !expected.includes(heading));
  missing = expected.filter((heading) => !actual.includes(heading));
} else {
  const expected = markerPrefixesOf(artifact.outline);
  if (expected.length === 0) throw new Error(`Outline for ${selected.artifact} has no recognizable markers; use --mode headings instead.`);
  const actualText = produced;
  missing = expected.filter((prefix) => !actualText.includes(prefix));
}

const ok = extra.length === 0 && missing.length === 0;
process.stdout.write(`${JSON.stringify({
  ok, mode: selected.mode, artifact: selected.artifact, flow: selected.flow, file: selected.file, matchedFiles, extra, missing,
})}\n`);
if (!ok) process.exitCode = 1;
