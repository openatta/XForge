import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactOutputs, assert as genericAssert, loadFlow, prepare as genericPrepare, producedArtifacts } from './_generic.mjs';

/**
 * The Verify Stage, measured on its own.
 *
 * `assurance` is the one Artifact whose value is entirely in what it cites. Its instruction asks for
 * verification "with traceable evidence", and every shipped Flow hangs a `requirement-coverage`
 * marker on one of its sections. A section that exists as a heading and holds nothing satisfies the
 * outline and defeats the point: an assurance whose "Gates and evidence" is a blank line reads, to
 * anything counting headings, exactly like one that did the work.
 *
 * So this checks that the sections the Flow keyed markers to actually carry prose. It does not
 * judge whether the prose is true — no probe can — but an empty section is decidable and is the
 * shape that has been observed.
 */

export const prepare = genericPrepare;

/** The body under a `## ` heading, up to the next one. */
function sectionBody(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('## ') && line.slice(3).trim() === heading);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

export async function assert(context) {
  const checks = await genericAssert(context);
  const { projectRoot, change, repositoryRoot, flow, stage } = context;

  const flowDefinition = await loadFlow({ repositoryRoot, flow });
  for (const artifact of producedArtifacts(flowDefinition, stage)) {
    const markers = artifact.markers ?? [];
    if (markers.length === 0) continue;
    const [output] = await artifactOutputs(projectRoot, change, artifact);
    if (!output) continue;
    const text = await readFile(output, 'utf8');

    for (const marker of markers) {
      const body = sectionBody(text, marker.section);
      checks.push({
        name: `${artifact.id}: section "${marker.section}" carries the ${marker.role} the Flow keyed to it`,
        ok: typeof body === 'string' && body.length > 0,
        detail: body === null
          ? `no "## ${marker.section}" heading in ${path.relative(projectRoot, output)}`
          : `${body.length} char(s)`,
      });
    }
  }
  return checks;
}
