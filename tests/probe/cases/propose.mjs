import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { specDeltaIsValid } from '../../../xforge/dist/core/spec-delta.js';
import { artifactOutputs, assert as genericAssert, loadFlow, prepare as genericPrepare, producedArtifacts } from './_generic.mjs';

/**
 * The Propose Stage, measured on its own.
 *
 * Beyond what every Stage owes, Propose is the one Stage whose output is machine-read rather than
 * merely well-shaped: `delta-specs` has to parse as a requirement delta before it satisfies its
 * Artifact at all. `core/flow-resolver.ts`'s `outputsSatisfyArtifact` applies `specDeltaIsValid` to
 * it for exactly that reason, so a file that exists and reads well but does not parse leaves the
 * Stage unable to exit — with a present, plausible-looking file as the only evidence.
 *
 * The same function is used here rather than a second implementation of the rule, because a probe
 * that agreed with its own copy of the parser and disagreed with the CLI would be worse than none.
 */

export const prepare = genericPrepare;

export async function assert(context) {
  const checks = await genericAssert(context);
  const { projectRoot, change, repositoryRoot, flow, stage } = context;

  const flowDefinition = await loadFlow({ repositoryRoot, flow });
  const delta = producedArtifacts(flowDefinition, stage).find((artifact) => artifact.id === 'delta-specs');
  if (!delta) return checks;

  const outputs = await artifactOutputs(projectRoot, change, delta);
  if (outputs.length === 0) return checks;

  const invalid = [];
  for (const output of outputs) {
    if (!specDeltaIsValid(await readFile(output, 'utf8'))) invalid.push(path.relative(projectRoot, output));
  }
  checks.push({
    name: 'every delta Spec parses as a requirement delta',
    ok: invalid.length === 0,
    detail: invalid.length === 0 ? `${outputs.length} file(s)` : invalid,
  });
  return checks;
}
