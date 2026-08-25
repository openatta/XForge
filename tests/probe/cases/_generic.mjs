import { readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse } from '../../../xforge/node_modules/yaml/dist/index.js';

/**
 * What every Stage owes, read out of the Flow rather than written down again here.
 *
 * A Stage declares which Artifacts it produces; each Artifact declares where it lands and what
 * sections it carries. That is enough to strip the Artifacts before the run and judge them after,
 * for any Stage of any Flow, without a bespoke module. `cases/<stage>.mjs` exists for what is
 * genuinely particular — a Check Agent keeping its verdict out of the prose — and builds on this
 * rather than repeating it.
 *
 * Nothing here hardcodes a Flow. The first version of `check.mjs` read `major.yaml` by name, which
 * was invisible while `major-check` was the only fixture and would have quietly judged a `solid`
 * fixture against the wrong outline the moment a second one existed.
 */

export const changePath = (projectRoot, change, ...rest) =>
  path.join(projectRoot, 'xforge', 'changes', change, ...rest);

export async function loadFlow({ repositoryRoot, flow }) {
  const flowPath = path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'flows', `${flow}.yaml`);
  return parse(await readFile(flowPath, 'utf8'));
}

/** The Artifact definitions a Stage produces, in the order the Flow lists them. */
export function producedArtifacts(flowDefinition, stage) {
  const definition = (flowDefinition.stages ?? []).find((entry) => entry.id === stage);
  const produced = new Set(definition?.produces ?? []);
  return (flowDefinition.artifacts ?? []).filter((artifact) => produced.has(artifact.id));
}

const isGlob = (pattern) => /[*?[\]{}]/.test(pattern);

/** Files an Artifact's `generates` actually resolved to, glob or not. */
export async function artifactOutputs(projectRoot, change, artifact) {
  const root = changePath(projectRoot, change);
  if (!isGlob(artifact.generates)) {
    const absolute = path.join(root, artifact.generates);
    return existsSync(absolute) ? [absolute] : [];
  }
  /* The only glob shape the shipped Flows use is `<dir>/**\/*.<ext>`, so walking the leading
     directory answers it without pulling a matcher in. An unrecognised shape reports nothing found
     rather than pretending, because a silent pass is the failure this file exists to avoid. */
  const [leading] = artifact.generates.split('/');
  const extension = path.extname(artifact.generates);
  const base = path.join(root, leading);
  if (!existsSync(base) || !extension) return [];
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.endsWith(extension)) found.push(absolute);
    }
  };
  await walk(base);
  return found.sort();
}

/** The `## ` headings an outline declares, in declaration order. */
export const declaredSections = (outline) => (outline ?? '')
  .split(/\r?\n/).filter((line) => line.trim().startsWith('## ')).map((line) => line.trim().slice(3).trim());

const writtenSections = (text) => text
  .split(/\r?\n/).filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim());

/** Removes every Artifact the Stage is meant to produce, so the Stage has a reason to produce it. */
export async function prepare({ projectRoot, change, repositoryRoot, flow, stage }) {
  const flowDefinition = await loadFlow({ repositoryRoot, flow });
  for (const artifact of producedArtifacts(flowDefinition, stage)) {
    if (isGlob(artifact.generates)) {
      await rm(changePath(projectRoot, change, artifact.generates.split('/')[0]), { recursive: true, force: true });
    } else {
      await rm(changePath(projectRoot, change, artifact.generates), { force: true });
    }
  }
}

export async function assert({ projectRoot, change, repositoryRoot, flow, stage }) {
  const flowDefinition = await loadFlow({ repositoryRoot, flow });
  const artifacts = producedArtifacts(flowDefinition, stage);
  const checks = [];

  if (artifacts.length === 0) {
    /* Said out loud rather than passing quietly. `apply` produces no Artifacts — what it owes is
       work-package delivery, which this generic case cannot see — so a green result here would
       mean "nothing was checked" while reading like "everything passed". */
    checks.push({
      name: `stage ${stage} declares no Artifacts, so this case measures nothing`,
      ok: false,
      detail: 'Write cases/' + stage + '.mjs, or probe a Stage that produces something.',
    });
    return checks;
  }

  for (const artifact of artifacts) {
    const outputs = await artifactOutputs(projectRoot, change, artifact);
    checks.push({
      name: `produces ${artifact.id}`,
      ok: outputs.length > 0,
      detail: outputs.length > 0 ? outputs.map((file) => path.relative(projectRoot, file)) : artifact.generates,
    });
    if (outputs.length === 0) continue;

    const sections = declaredSections(artifact.outline);
    if (sections.length > 0) {
      for (const output of outputs) {
        const written = writtenSections(await readFile(output, 'utf8'));
        const missing = sections.filter((heading) => !written.includes(heading));
        const extra = written.filter((heading) => !sections.includes(heading));
        /* Omission and invention are separate results. A missing section breaks whatever is keyed
           to it; an invented one means the Agent had something to say and nowhere declared to say
           it, which is a statement about the Flow rather than about the Agent. */
        checks.push({ name: `${artifact.id}: no declared section omitted`, ok: missing.length === 0, detail: missing });
        checks.push({ name: `${artifact.id}: no section invented`, ok: extra.length === 0, detail: extra });
      }
      continue;
    }

    /* An Artifact whose outline is a YAML shape rather than headings is judged on parsing, which is
       the property anything reading it depends on. */
    if (outputs.every((output) => output.endsWith('.yaml'))) {
      for (const output of outputs) {
        let parsed = null;
        try { parsed = parse(await readFile(output, 'utf8')); } catch { parsed = null; }
        checks.push({
          name: `${artifact.id}: parses as YAML`,
          ok: parsed !== null && typeof parsed === 'object',
          detail: path.relative(projectRoot, output),
        });
      }
    }
  }
  return checks;
}
