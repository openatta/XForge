import { readFile } from 'node:fs/promises';
import { parse } from '../../../xforge/node_modules/yaml/dist/index.js';
import { artifactOutputs, assert as genericAssert, loadFlow, prepare as genericPrepare, producedArtifacts } from './_generic.mjs';

/**
 * The Clarify Stage, measured on its own.
 *
 * Clarify's real output is not the prose beside it — it is `materialQuestions`, the conditions
 * ledger the Stage exit decides on. `evaluateExitCondition` requires every entry to be complete and
 * attributed, and a Stage that declares no Gates and no Approvals has that ledger as its only
 * blocker. So an entry missing its decision or its decider is the difference between a Stage that
 * governed something and one that was vacuously satisfied — which is precisely what a live Major
 * run was found doing before `14eb090`: the ledger held an overruled decision, the condition passed,
 * and the whole Stage was a no-op on every rework path.
 *
 * Attribution is checked for presence, not for truthfulness. A session can write any name it likes,
 * and a probe that pretended otherwise would be asserting something it cannot observe.
 */

export const prepare = genericPrepare;

export async function assert(context) {
  const checks = await genericAssert(context);
  const { projectRoot, change, repositoryRoot, flow, stage } = context;

  const flowDefinition = await loadFlow({ repositoryRoot, flow });
  const ledgerArtifact = producedArtifacts(flowDefinition, stage).find((artifact) => artifact.id === 'material-questions');
  if (!ledgerArtifact) return checks;

  const [output] = await artifactOutputs(projectRoot, change, ledgerArtifact);
  if (!output) return checks;

  let ledger = null;
  try { ledger = parse(await readFile(output, 'utf8')); } catch { /* the generic case already reported it */ }
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : null;

  checks.push({
    name: 'the conditions ledger carries entries',
    ok: entries !== null && entries.length > 0,
    /* An empty list is not the same shape as a decided one: it carries no timestamp to compare
       against the transition chain, which is why `14eb090` reaches entries and leaves `entries: []`
       standing rather than patching a synthesized one in. */
    detail: entries === null ? 'no readable entries' : `${entries.length} entr(y|ies)`,
  });
  if (!entries?.length) return checks;

  const incomplete = entries
    .filter((entry) => !entry?.id || !entry?.question || !entry?.decision)
    .map((entry) => entry?.id ?? '(unidentified)');
  const unattributed = entries
    .filter((entry) => !entry?.decidedBy || !entry?.decidedAt)
    .map((entry) => entry?.id ?? '(unidentified)');

  checks.push({ name: 'every entry states a question and its decision', ok: incomplete.length === 0, detail: incomplete });
  checks.push({ name: 'every entry names a decider and a time', ok: unattributed.length === 0, detail: unattributed });
  return checks;
}
