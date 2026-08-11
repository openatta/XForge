import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '../../xforge/node_modules/yaml/dist/index.js';

/**
 * Coverage is derived from the same data the runtime itself reads (manifest.yaml's
 * scaffold.skills, each flow yaml's stages[].skill) rather than a hand-maintained skill list,
 * so adding a Skill or Flow later (per docs/extending-skills-and-flows.md) makes this fail
 * loudly instead of silently shipping untested.
 */

const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const scaffoldPayloadRoot = path.join(repositoryRoot, 'scaffold', 'payload', 'xforge');
const matrixPath = path.join(repositoryRoot, 'tests', 'live-engine', 'coverage-matrix.yaml');

const manifest = parse(await readFile(path.join(scaffoldPayloadRoot, 'manifest.yaml'), 'utf8'));
const declaredSkills = new Set(manifest.scaffold.skills);

const flowsDirectory = path.join(scaffoldPayloadRoot, 'flows');
const flowFiles = (await readdir(flowsDirectory)).filter((name) => name.endsWith('.yaml'));
/** @type {Map<string, Set<string>>} skill -> set of "flow:stage" pairs that use it */
const flowStagesBySkill = new Map();
for (const file of flowFiles) {
  const flow = parse(await readFile(path.join(flowsDirectory, file), 'utf8'));
  const flowName = flow.metadata.name;
  for (const stage of flow.stages ?? []) {
    if (!flowStagesBySkill.has(stage.skill)) flowStagesBySkill.set(stage.skill, new Set());
    flowStagesBySkill.get(stage.skill).add(`${flowName}:${stage.id}`);
  }
}

const matrix = parse(await readFile(matrixPath, 'utf8'));
/** @type {Map<string, Array<{scenario:string, pair:string|null}>>} */
const matrixBySkill = new Map();
for (const entry of matrix.entries ?? []) {
  matrixBySkill.set(entry.skill, (entry.scenarios ?? []).map((scenario) => ({
    scenario: scenario.scenario,
    pair: scenario.flow && scenario.stage ? `${scenario.flow}:${scenario.stage}` : null,
  })));
}

const problems = [];

for (const skill of declaredSkills) {
  const matrixEntries = matrixBySkill.get(skill);
  if (!matrixEntries || matrixEntries.length === 0) {
    problems.push(`Skill "${skill}" is declared in manifest.yaml but has no coverage-matrix entry.`);
    continue;
  }
  const requiredPairs = flowStagesBySkill.get(skill);
  if (requiredPairs) {
    const coveredPairs = new Set(matrixEntries.map((entry) => entry.pair).filter(Boolean));
    for (const pair of requiredPairs) {
      if (!coveredPairs.has(pair)) problems.push(`Skill "${skill}" is used by Flow stage "${pair}" but the coverage matrix has no scenario for that pair.`);
    }
  } else if (!matrixEntries.some((entry) => entry.pair === null)) {
    problems.push(`Skill "${skill}" is not used by any Flow stage (standalone Skill) but the coverage matrix has no standalone (flow: null) scenario for it.`);
  }
}

for (const skill of matrixBySkill.keys()) {
  if (!declaredSkills.has(skill)) problems.push(`Coverage matrix references Skill "${skill}", which is not declared in manifest.yaml's scaffold.skills.`);
}

const ok = problems.length === 0;
process.stdout.write(`${JSON.stringify({
  ok,
  declaredSkillCount: declaredSkills.size,
  matrixSkillCount: matrixBySkill.size,
  problems,
}, null, 2)}\n`);
process.exitCode = ok ? 0 : 1;
