import { documentSections as sections, markerOccurrences } from '../artifact-markers.js';
import type { ArtifactSource, LedgerFinding, LedgerPrinciple, MaterialDecision, ReconciliationObservation, SpecRequirement } from './model.js';

/**
 * Differences between what a record claims and what the files contain.
 *
 * Every rule here is a pure function over rows the reading layer already produced, and every one of
 * them states a difference without calling it a defect -- the distinction the brief prints in its
 * own header, and the reason an approver can read this section without either dismissing it as
 * noise or treating it as a failure.
 *
 * Pure by construction, which is the point of the separation: a reconciliation rule that could read
 * a file could also disagree with the layer that already read it.
 */

/**
 * RC-1 — a finding recorded as resolved whose cited Requirement is absent from the cited Artifact.
 *
 * The ledger's `status` is a word somebody typed; nothing in XForge has ever compared it against
 * the Artifact it claims to have changed. When the cited Artifact declares a
 * `requirement-coverage` marker, the search is narrowed to that section, because "add this to the
 * test strategy" is not satisfied by the Requirement appearing somewhere else in the document.
 */
export function reconcileResolvedFindings(
  findings: LedgerFinding[],
  requirements: SpecRequirement[],
  sources: ArtifactSource[],
): ReconciliationObservation[] {
  const observations: ReconciliationObservation[] = [];
  const anchors = new Set(requirements.map((entry) => entry.anchor));
  for (const finding of findings) {
    if (finding.status !== 'resolved') continue;
    const citedRequirements = finding.refs.filter((ref) => anchors.has(ref));
    const citedArtifacts = finding.refs.filter((ref) => sources.some((source) => source.path.endsWith(ref) || ref.endsWith(source.path)));
    if (citedRequirements.length === 0 || citedArtifacts.length === 0) continue;
    for (const artifactRef of citedArtifacts) {
      const source = sources.find((entry) => entry.path.endsWith(artifactRef) || artifactRef.endsWith(entry.path));
      if (!source || !source.due) continue;
      const coverage = source.markers.find((marker) => marker.role === 'requirement-coverage');
      const parsed = sections(source.content);
      const scope = coverage ? parsed.get(coverage.section) : null;
      /* A Flow that declares a coverage section the Artifact does not have is reported as its own
         difference rather than silently widened to the whole document. */
      if (coverage && !scope) {
        observations.push({
          id: `RC-1:${finding.id}:${source.id}:section-missing`,
          rule: 'RC-1',
          code: 'XFORGE_BRIEF_COVERAGE_SECTION_MISSING',
          provenance: 'computed',
          summary: `${source.path} does not contain the "${coverage.section}" section its Flow declares as the Requirement-coverage section.`,
          refs: [source.path],
        });
        continue;
      }
      const haystack = scope ? scope.body : source.content;
      for (const requirement of citedRequirements) {
        if (haystack.includes(requirement)) continue;
        observations.push({
          id: `RC-1:${finding.id}:${requirement}`,
          rule: 'RC-1',
          code: 'XFORGE_BRIEF_RESOLUTION_UNVERIFIED',
          provenance: 'computed',
          summary: scope
            ? `Finding ${finding.id} is recorded as resolved and cites ${requirement} together with ${source.path}, but ${requirement} does not appear in that file's "${coverage!.section}" section.`
            : `Finding ${finding.id} is recorded as resolved and cites ${requirement} together with ${source.path}, but ${requirement} does not appear in that file.`,
          refs: [finding.id, requirement, source.path],
        });
      }
    }
  }
  return observations;
}
/** RC-2 — a Requirement no Artifact in this Change references at all. */
export function reconcileRequirementAnchors(
  requirements: SpecRequirement[],
  sources: ArtifactSource[],
): ReconciliationObservation[] {
  const observations: ReconciliationObservation[] = [];
  for (const requirement of requirements) {
    if (requirement.operation === 'REMOVED') continue;
    const anchored = sources.some((source) => source.content.includes(requirement.anchor));
    if (anchored || sources.length === 0) continue;
    observations.push({
      id: `RC-2:${requirement.anchor}`,
      rule: 'RC-2',
      code: 'XFORGE_BRIEF_REQUIREMENT_UNANCHORED',
      provenance: 'computed',
      summary: `${requirement.anchor} is declared in ${requirement.file} and is referenced by none of this Change's other Artifacts.`,
      refs: [requirement.anchor, requirement.file],
    });
  }
  return observations;
}
/** RC-3 — a Requirement absent from the section the Flow declares as Requirement coverage. */
export function reconcileCoverageSections(
  requirements: SpecRequirement[],
  sources: ArtifactSource[],
): ReconciliationObservation[] {
  const observations: ReconciliationObservation[] = [];
  for (const source of sources) {
    if (!source.due) continue;
    const coverage = source.markers.find((marker) => marker.role === 'requirement-coverage');
    if (!coverage) continue;
    const scope = sections(source.content).get(coverage.section);
    if (!scope) continue;
    for (const requirement of requirements) {
      if (requirement.operation === 'REMOVED') continue;
      if (scope.body.includes(requirement.anchor)) continue;
      observations.push({
        id: `RC-3:${source.id}:${requirement.anchor}`,
        rule: 'RC-3',
        code: 'XFORGE_BRIEF_REQUIREMENT_UNCOVERED',
        provenance: 'computed',
        summary: `${requirement.anchor} is not named in the "${coverage.section}" section of ${source.path}.`,
        refs: [requirement.anchor, source.path],
      });
    }
  }
  return observations;
}
/** RC-4 — an Artifact entry that defers a question, with no finding citing what it deferred. */
export function reconcileDeclaredGaps(
  sources: ArtifactSource[],
  findings: LedgerFinding[],
): ReconciliationObservation[] {
  const observations: ReconciliationObservation[] = [];
  const cited = new Set(findings.flatMap((finding) => finding.refs));
  for (const source of sources) {
    for (const marker of source.markers) {
      if (marker.role !== 'declared-gap' || !marker.pattern?.length) continue;
      const scope = sections(source.content).get(marker.section);
      if (!scope) continue;
      for (const occurrence of markerOccurrences(scope, marker)) {
        /* Backticked tokens are what a finding could cite back — a Requirement id, a path. An
           entry that names none of them is reported as exactly that, rather than being matched
           against prose. */
        const subjects = [...occurrence.text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
        if (subjects.length > 0 && subjects.some((subject) => cited.has(subject))) continue;
        observations.push({
          id: `RC-4:${source.id}:${occurrence.line}`,
          rule: 'RC-4',
          code: 'XFORGE_BRIEF_DECLARED_GAP_UNRESOLVED',
          provenance: 'computed',
          summary: subjects.length > 0
            ? `${source.path}:${occurrence.line} defers ${subjects.join(', ')} to a later Stage, and no finding cites ${subjects.length > 1 ? 'any of them' : 'it'}.`
            : `${source.path}:${occurrence.line} defers a question to a later Stage without naming a subject a finding could cite.`,
          refs: [source.path, ...subjects],
        });
      }
    }
  }
  return observations;
}
/**
 * RC-6 — a material question decided, and the Artifact it overruled never revised.
 *
 * The clarify Stage declares `revises: [proposal, delta-specs]`, so the Flow says the write-back is
 * owed. Nothing checked that it happened. In a live Major run three parts of the Proposal survived
 * decisions that had overruled them — an Actor that no longer holds credentials, a success
 * criterion describing whole-repository sync after the decision narrowed it, and one that
 * contradicted a Requirement outright. All three were caught by a person re-reading the document;
 * the third would otherwise have carried an acceptance criterion into Check stating what the Change
 * had decided not to do.
 *
 * The comparison is the same one RC-1 makes — what a ledger claims against what the files contain —
 * so it is stated the same way: a decision names where it must land, and this reports where it did
 * not. Timestamps are not compared, because file mtimes do not survive a clone and would report
 * every Change re-checked out anywhere.
 */
export function reconcileMaterialDecisions(
  decisions: MaterialDecision[],
  sources: ArtifactSource[],
): ReconciliationObservation[] {
  const observations: ReconciliationObservation[] = [];
  for (const decision of decisions) {
    for (const target of decision.revises) {
      const source = sources.find((entry) => entry.path.endsWith(target) || target.endsWith(entry.path));
      if (!source) continue;
      /* The decision's own words are the only anchor available: if none of its distinctive terms
         appears in the Artifact it was supposed to revise, nothing was written back. Short common
         words are dropped so the test is about substance rather than grammar. */
      const terms = decision.decision
        .split(/[\s,.;:()（）、，。；：]+/)
        .filter((word) => word.length >= 4)
        .slice(0, 12);
      if (terms.length === 0) continue;
      if (terms.some((term) => source.content.includes(term))) continue;
      observations.push({
        id: `RC-6:${decision.id}:${source.id}`,
        rule: 'RC-6',
        code: 'XFORGE_BRIEF_DECISION_NOT_WRITTEN_BACK',
        provenance: 'computed',
        summary: `Material question ${decision.id} was decided on ${decidedOn(decision.decidedAt)} and names ${source.path} as an Artifact it revises, but none of the decision's own terms appears in that file.`,
        refs: [decision.id, source.path],
      });
    }
  }
  return observations;
}
function decidedOn(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '(no date recorded)';
}
/**
 * RC-5 — a Constitution reference that resolves to nothing.
 *
 * "Resolves" has to mean here exactly what it means in `constitution-check.ts`'s `resolveReference`,
 * which is the Gate that decides whether the same citation is acceptable. It did not: that function
 * tries the reference Change-relative and then project-relative, while this one consulted a set built
 * only from the Change's own Artifacts. A principle citing `xforge/architecture.md` — a real file,
 * and the most natural thing an architecture principle can cite — passed the Gate and was reported
 * here as neither a Requirement nor a file that exists. The observed cost was not confusion but a
 * worse Constitution: the citation was rewritten to a Change-local path to silence a false alarm.
 *
 * `resolvesOnDisk` is supplied by the caller, which has already awaited the same two candidate
 * spellings the Gate tries. Keep the two in step; a divergence here reads to everyone as a defect in
 * whichever component they happen to be looking at.
 */
export function reconcileConstitutionReferences(
  principles: LedgerPrinciple[],
  requirements: SpecRequirement[],
  sources: ArtifactSource[],
  gatePassed: Set<string>,
  existingPaths: Set<string>,
  resolvesOnDisk: Set<string>,
): ReconciliationObservation[] {
  const observations: ReconciliationObservation[] = [];
  const anchors = new Set(requirements.map((entry) => entry.anchor));
  const headings = new Set(requirements.map((entry) => entry.heading));
  for (const principle of principles) {
    for (const reference of principle.references) {
      const gate = /^gate:(.+)$/i.exec(reference);
      if (gate) {
        if (gatePassed.has(gate[1]!.trim())) continue;
        observations.push({
          id: `RC-5:${principle.principle}:${reference}`,
          rule: 'RC-5',
          code: 'XFORGE_BRIEF_REFERENCE_UNRESOLVABLE',
          provenance: 'computed',
          summary: `Principle "${principle.principle}" cites ${reference}, and no Gate Evidence for this revision records that Gate as passed.`,
          refs: [reference],
        });
        continue;
      }
      if (anchors.has(reference) || headings.has(reference)) continue;
      if (existingPaths.has(reference) || sources.some((source) => source.path.endsWith(reference))) continue;
      if (resolvesOnDisk.has(reference)) continue;
      observations.push({
        id: `RC-5:${principle.principle}:${reference}`,
        rule: 'RC-5',
        code: 'XFORGE_BRIEF_REFERENCE_UNRESOLVABLE',
        provenance: 'computed',
        summary: `Principle "${principle.principle}" cites ${reference}, which is neither a Requirement in this Change nor a file that exists in the Change directory or the repository.`,
        refs: [reference],
      });
    }
  }
  return observations;
}

/* ------------------------------------------------------------------ the brief itself */
