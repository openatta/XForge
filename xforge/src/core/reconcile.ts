import { access } from 'node:fs/promises';
import type { Diagnostic, NextAction, ProjectContext, StageFlow } from '../types.js';
import { diagnostic } from './errors.js';
import { safeResolve } from './path-safety.js';
import { gateBlockReason, readGateEvidence, type ResolvedControlPlane } from './control-plane.js';
import type { ReconciliationObservation } from './reconcile/model.js';
import {
  readArtifactSources, readContractElements, readFindings, readMaterialDecisions, readPrinciples,
  readSpecRequirements,
} from './reconcile/sources.js';
import {
  reconcileConstitutionReferences, reconcileContractImpact, reconcileCoverageSections,
  reconcileDeclaredGaps, reconcileMaterialDecisions, reconcileRequirementAnchors,
  reconcileResolvedFindings,
} from './reconcile/rules.js';

/**
 * Differences between what a Change's records claim and what its files contain.
 *
 * These rules were a section of `xforge brief`. The brief is gone — it grew into a
 * thirty-six-kilobyte document that had to be relayed verbatim through a model's context to reach a
 * person, which is neither what it was designed for (one screen, once per turn) nor something a
 * model should be carrying. What it printed was mostly EXTRACTED: whole Artifacts quoted back.
 *
 * This part is not that. It reads the same files and emits one to three kilobytes of *differences*,
 * every one of them actionable, and a field report called it the single most valuable mechanism in
 * the release — RC-5 forced a Gate to be re-run, which is how an unattributable `resolvedBy` was
 * caught instead of archived. Deleting it with the document it happened to be printed in would have
 * thrown away the part that worked.
 *
 * So it runs from `check`, which is where the Gates are, which every Stage runs anyway, and which
 * already reads most of these files. Reported as diagnostics rather than a section:
 *
 * - **`info`, never a failure.** Every rule states a difference and none of them decides whether it
 *   is a problem — that distinction is written into `rules.ts` and holding to it here is what keeps
 *   an approver able to read this without either dismissing it as noise or treating it as a block.
 * - **Only for a Change.** They compare a Change's own records against each other; there is nothing
 *   to reconcile at the project level.
 * - **Never on a Flow without governed Stages.** The rules read Artifacts a Stage declares, and a
 *   Flow with no Stages declares none.
 */
export async function reconcileChange(
  project: ProjectContext,
  changeId: string,
  flow: StageFlow,
  control: ResolvedControlPlane,
): Promise<{ observations: ReconciliationObservation[]; diagnostics: Diagnostic[]; nextActions: NextAction[] }> {
  const diagnostics: Diagnostic[] = [];
  const stage = control.governance.currentStage;

  const findingsResult = await readFindings(project, changeId);
  const artifactResult = await readArtifactSources(project, changeId, flow, stage);
  const specResult = await readSpecRequirements(project, changeId);
  const principlesResult = await readPrinciples(project, changeId);
  const contractResult = await readContractElements(project, changeId);

  /*
   * A source that could not be read is reported rather than skipped.
   *
   * Each reader hands back an `unavailable` entry naming the section it could not produce and why.
   * Dropping those would make a rule that found nothing indistinguishable from a rule whose input
   * was missing — the difference between "these records agree" and "one of them could not be
   * opened", which is the whole reason the readers carry the list.
   */
  for (const entry of [...findingsResult.unavailable, ...artifactResult.unavailable, ...specResult.unavailable, ...principlesResult.unavailable, ...contractResult.unavailable]) {
    diagnostics.push(diagnostic(entry.code, `${entry.section}: ${entry.reason}`, `${project.changesPath}/${changeId}`, 'warning'));
  }

  const sources = artifactResult.sources;
  const requirements = specResult.requirements;

  /*
   * Whether each Gate counts as passed at this revision, and separately what its Evidence recorded.
   *
   * RC-5 needs both. `gatePassed` excludes a Gate for three different reasons — never ran, ran and
   * failed, ran at an older revision — and telling a reader to "wait for it to run" is the wrong
   * instruction for a Gate that ran and failed, and hides the failure while it is at it.
   */
  const gatePassed = new Set<string>();
  const gateRecorded = new Map<string, string>();
  for (const gateId of control.resources.gates.keys()) {
    const evidence = await readGateEvidence(project, changeId, gateId, control.resources);
    if (evidence) gateRecorded.set(gateId, evidence.status);
    if (!gateBlockReason(evidence, control.governance.revision.contentRevision)) gatePassed.add(gateId);
  }

  const existingPaths = new Set<string>();
  const changeRoot = `${project.changesPath}/${changeId}/`;
  for (const source of sources) {
    existingPaths.add(source.path);
    existingPaths.add(source.path.slice(changeRoot.length));
  }
  for (const requirement of requirements) {
    existingPaths.add(requirement.file);
    existingPaths.add(requirement.file.slice(changeRoot.length));
  }

  /*
   * The same two spellings `constitution-check.ts`'s `resolveReference` tries, resolved here so RC-5
   * agrees with the Gate that already accepted these citations. Done once for the whole principle
   * set rather than inside the pure rule, which stays synchronous and testable.
   */
  const resolvesOnDisk = new Set<string>();
  for (const principle of principlesResult.principles) {
    for (const reference of principle.references) {
      if (/^gate:/i.test(reference) || resolvesOnDisk.has(reference)) continue;
      for (const candidate of [`${changeRoot}${reference}`, reference]) {
        try {
          await access(await safeResolve(project.root, candidate));
          resolvesOnDisk.add(reference);
          break;
        } catch { /* try the next spelling */ }
      }
    }
  }

  const observations: ReconciliationObservation[] = [
    ...reconcileResolvedFindings(findingsResult.findings, requirements, sources),
    ...reconcileRequirementAnchors(requirements, sources),
    ...reconcileCoverageSections(requirements, sources),
    ...reconcileDeclaredGaps(sources, findingsResult.findings),
    ...reconcileConstitutionReferences(
      principlesResult.principles,
      requirements,
      sources,
      gatePassed,
      existingPaths,
      resolvesOnDisk,
      new Set(project.manifest.scaffold.gates ?? []),
      gateRecorded,
    ),
    ...reconcileMaterialDecisions(await readMaterialDecisions(project, changeId), sources),
    ...reconcileContractImpact(
      contractResult.elements,
      contractResult.declared,
      control.state.classification,
      control.state.scope.modules,
    ),
  ];

  for (const observation of observations) {
    diagnostics.push(diagnostic(
      observation.code,
      `${observation.rule}: ${observation.summary}`,
      `${project.changesPath}/${changeId}`,
      'info',
      { rule: observation.rule, refs: observation.refs },
    ));
  }

  /*
   * Findings waiting on a person, with the command that closes each one.
   *
   * Not a reconciliation rule — nothing here compares two records. It is carried alongside them
   * because it is the one other thing the deleted brief printed that a reader *acts on*, and losing
   * it with the document would have been an unnoticed regression: a live run read the placeholder
   * form `--change <id> --id <finding-id>`, had three such entries in front of it, and archived with
   * all three still open. What a reader can run, they run; what they have to assemble first competes
   * with signing and loses.
   *
   * `status !== 'resolved'` rather than a literal `open`, matching `core/check-findings.ts`: a
   * warning or suggestion written to instruction carries no `status` at all, and reading that
   * absence differently in two places is how the original defect got past everybody. Only the answer
   * and the name are left blank, deliberately — they are the person's, and a command carrying a
   * plausible default for either is how an Agent signs somebody else's decision.
   */
  const nextActions: NextAction[] = findingsResult.findings
    .filter((finding) => finding.status !== 'resolved' && !finding.reworkTo.trim())
    .map((finding) => ({
      action: 'answer-finding',
      type: 'governance' as const,
      actor: 'human' as const,
      status: 'ready' as const,
      id: finding.id,
      reason: `Finding ${finding.id} is awaiting your answer: ${finding.summary}`,
      command: ['xforge', 'findings', 'resolve', '--change', changeId, '--id', finding.id, '--answer', '<what you decided>', '--by', '<you>'],
    }));

  return { observations, diagnostics, nextActions };
}
