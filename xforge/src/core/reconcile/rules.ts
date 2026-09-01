import { documentSections as sections, markerOccurrences } from '../artifact-markers.js';
import type { ArtifactSource, ContractElement, LedgerFinding, LedgerPrinciple, MaterialDecision, ReconciliationObservation, SpecRequirement } from './model.js';
import { isObservabilityPrinciple } from '../constitution-check.js';

/**
 * Differences between what a record claims and what the files contain.
 *
 * Every rule here is a pure function over rows the reading layer already produced, and every one of
 * them states a difference without calling it a defect -- the distinction `check` keeps by reporting
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
          code: 'XFORGE_RECONCILE_COVERAGE_SECTION_MISSING',
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
          code: 'XFORGE_RECONCILE_RESOLUTION_UNVERIFIED',
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
      code: 'XFORGE_RECONCILE_REQUIREMENT_UNANCHORED',
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
        code: 'XFORGE_RECONCILE_REQUIREMENT_UNCOVERED',
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
        /*
         * Or the Artifact the deferral is written in.
         *
         * "Backticked tokens are what a finding could cite back" assumed authors backtick locations.
         * They backtick subjects: a live run deferred `test/**` and
         * `observable-requirements-are-tested` -- a glob and a Rule id -- and neither is a thing
         * `check-findings` will resolve. Citing them cleared this rule and drew two "not a
         * Requirement, not a path" warnings from the Gate; citing `design.md` cleared the Gate and
         * brought this rule straight back. The run reported it as no ref set satisfying both, and
         * it was right.
         *
         * A finding that names the Artifact holding the deferral has answered the question this
         * rule asks -- somebody looked at that gap -- and it names a location both mechanisms
         * accept.
         */
        if (cited.has(source.path) || cited.has(source.path.split('/').pop() ?? '')) continue;
        observations.push({
          id: `RC-4:${source.id}:${occurrence.line}`,
          rule: 'RC-4',
          code: 'XFORGE_RECONCILE_DECLARED_GAP_UNRESOLVED',
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
        code: 'XFORGE_RECONCILE_DECISION_NOT_WRITTEN_BACK',
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
/**
 * The three states a `gate:` citation can be in, kept in step with `core/constitution-check.ts`'s
 * `describeDangling`. The two report the same citation, and a reader who sees them disagree reads
 * it as a defect in whichever component they happen to be looking at.
 */
function gateSummary(
  principle: string,
  reference: string,
  name: string,
  declaredGates: Set<string>,
  gateRecorded: Map<string, string>,
): string {
  if (!declaredGates.has(name)) return `Principle "${principle}" cites ${reference}, and this project selects no Gate by that name.`;
  const recorded = gateRecorded.get(name);
  if (recorded !== undefined && recorded !== 'passed') {
    return `Principle "${principle}" cites ${reference}, and that Gate ran and recorded ${recorded}, not passed. The citation names real Evidence; the Evidence does not support the claim. Fix what the Gate is reporting rather than the citation.`;
  }
  /*
   * Passed, and then the revision moved out from under it — the case this ledger creates for itself.
   *
   * A Constitution principle citing `gate:check-findings` is citing a Check Stage Gate, and nothing
   * after the Check Stage re-runs it. Every later Artifact write — the assurance, the verification
   * receipt — advances the content revision, so by the archive path that citation is guaranteed to
   * name Evidence bound to an older one. It is the ordinary outcome of following the Flow, not a
   * mistake, and it has exactly one repair: run that Gate again after the last write.
   *
   * These two were one sentence, which said the Gate "runs at a later Stage than the one this ledger
   * was written at". That is true of a Gate that has never run and false of this one, which ran at an
   * *earlier* Stage — a field report read it, could not reconcile it with what it was seeing, and
   * worked the remedy out from the mechanism instead. The command is stated here now.
   */
  if (recorded === 'passed') {
    return `Principle "${principle}" cites ${reference}, and that Gate passed against an earlier content revision than the one being archived. Every Artifact written after a Gate runs moves the revision, so a Gate from an earlier Stage — nothing re-runs the Check Stage's Gates — is stale by the time the ledger is read here. The citation is right and its Evidence is out of date: re-run \`xforge check --gate ${name}\` after the last Artifact write, and this resolves.`;
  }
  return `Principle "${principle}" cites ${reference}. That Gate is selected by this project and has never run, so there is no Evidence to resolve the citation against — it runs at a later Stage than the one this ledger was written at, and the citation resolves once it has. This states a timing difference, not a wrong citation.`;
}

export function reconcileConstitutionReferences(
  principles: LedgerPrinciple[],
  requirements: SpecRequirement[],
  sources: ArtifactSource[],
  gatePassed: Set<string>,
  existingPaths: Set<string>,
  resolvesOnDisk: Set<string>,
  /**
   * Every Gate the project selects, run or not.
   *
   * Kept in step with `core/constitution-check.ts`'s `describeDangling`: the two report the same
   * citation, and a reader who sees them disagree reads it as a defect in whichever component they
   * happen to be looking at. That has already happened once with this rule.
   */
  declaredGates: Set<string> = new Set(),
  /**
   * What each Gate's Evidence recorded, for the Gates that produced any.
   *
   * The third of `describeDangling`'s three branches. Without it this rule cannot tell "has not run
   * yet" from "ran and failed", and told the author of a *failing* Gate to wait for it — suppressing
   * the one signal that mattered while claiming the citation was fine.
   */
  gateRecorded: Map<string, string> = new Map(),
): ReconciliationObservation[] {
  const observations: ReconciliationObservation[] = [];
  const anchors = new Set(requirements.map((entry) => entry.anchor));
  const headings = new Set(requirements.map((entry) => entry.heading));
  for (const principle of principles) {
    for (const reference of principle.references) {
      const gate = /^gate:(.+)$/i.exec(reference);
      if (gate) {
        if (gatePassed.has(gate[1]!.trim())) continue;
        const name = gate[1]!.trim();
        observations.push({
          id: `RC-5:${principle.principle}:${reference}`,
          rule: 'RC-5',
          code: 'XFORGE_RECONCILE_REFERENCE_UNRESOLVABLE',
          provenance: 'computed',
          summary: gateSummary(principle.principle, reference, name, declaredGates, gateRecorded),
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
        code: 'XFORGE_RECONCILE_REFERENCE_UNRESOLVABLE',
        provenance: 'computed',
        summary: `Principle "${principle.principle}" cites ${reference}, which is neither a Requirement in this Change nor a file that exists in the Change directory or the repository.`,
        refs: [reference],
      });
    }
  }
  return observations;
}


/**
 * RC-7 -- the contract delta against what the Change says about itself.
 *
 * `eligibleWhen.contractImpact` acts on `classification.moduleContract`, and the classification is a
 * self-report: it decides which Flow a Change may run on, and nothing compares it with anything.
 * That leaves a shape where both records are individually valid and cannot both be right -- a
 * classification saying no interface moves, and a contract delta in the same directory naming three
 * elements that do.
 *
 * Stated, never judged, like every rule in this file. A delta written before the classification was
 * updated and a classification written before the interface moved are the same observation seen from
 * opposite ends, and nothing here can tell which end it is looking at. The `info` that comes out
 * says what the two records say; a person decides which one to change.
 *
 * Silence is deliberate for the Change that holds no contract delta at all. `declared` is false
 * there, and an absent document is not a record that disagrees with anything -- most Changes touch
 * no interface, and a rule that spoke about all of them would be the permanent unactionable finding
 * this codebase refuses elsewhere.
 */
/**
 * The ids a summary names, capped, with the count carrying the rest.
 *
 * `refs` already holds the full set and is the channel a tool reads; the summary is the sentence a
 * person reads. The worst case is not exotic -- the first Change after adoption declares the whole
 * extracted surface at once, which is the one-time cost this design is most often criticised for --
 * and an `info` line naming three hundred ids is one nobody finishes.
 */
function named(ids: string[], limit = 8): string {
  return ids.length <= limit ? ids.join(', ') : `${ids.slice(0, limit).join(', ')}, and ${ids.length - limit} more`;
}

/**
 * The observability cross-check the Constitution Gate defers, performed where the Evidence exists.
 *
 * `constitution-check` refuses to take an Agent's word that a principle about automated
 * verification is satisfied: it reads the `unit-tests` Gate Evidence and fails a `compliant` answer
 * the Evidence contradicts. On every shipped Flow that check is structurally impossible where it
 * lives -- the Gate runs at the Check Stage, `unit-tests` runs at Verify after it, nothing re-runs
 * a Check-Stage Gate, and archive's mandatory set is the Verify Stage's. So the Gate emitted "it
 * will be checked again once the Gate has run" and no Stage ever did. A live run of all four Flows
 * found it by reading the Evidence file, because that warning never reaches `diagnostics` either.
 *
 * The reconciliation pass runs at every Stage, so at Verify it holds both halves at once: the
 * ledger's answer, and what the Gate recorded. `info`, like every rule here -- it states the
 * difference and leaves the judgement to the approver reading it, which is the same standing RC-5
 * has, and RC-5 is the rule that forced a Gate re-run rather than an archive.
 */
export function reconcileObservabilityCrossCheck(
  principles: LedgerPrinciple[],
  gateRecorded: Map<string, string>,
): ReconciliationObservation[] {
  const recorded = gateRecorded.get('unit-tests');
  if (!recorded || recorded === 'passed') return [];
  return principles
    .filter((entry) => entry.status === 'compliant' && isObservabilityPrinciple(entry.principle))
    .map((entry) => ({
      id: `RC-8:${entry.principle}`,
      rule: 'RC-8',
      code: 'XFORGE_RECONCILE_OBSERVABILITY_UNVERIFIED',
      provenance: 'computed' as const,
      summary: `The Constitution ledger answers "${entry.principle}" compliant, and this Change's unit-tests Gate Evidence now records status "${recorded}". The Gate that reads this pair runs at the Check Stage, before unit-tests has run, so it could not check it there and nothing re-runs it. Automated verification that does not pass does not establish compliance.`,
      refs: [`gate:unit-tests`],
    }));
}

export function reconcileContractImpact(
  elements: ContractElement[],
  declared: boolean,
  classification: { moduleContract?: boolean },
  scopeModules: string[],
): ReconciliationObservation[] {
  if (!declared) return [];
  const observations: ReconciliationObservation[] = [];
  const claimed = classification.moduleContract === true;

  if (elements.length > 0 && !claimed) {
    const ids = [...new Set(elements.map((element) => element.id))].sort();
    observations.push({
      id: 'RC-7:classification',
      rule: 'RC-7',
      code: 'XFORGE_RECONCILE_CONTRACT_IMPACT_UNDECLARED',
      provenance: 'computed',
      summary: `This Change's contract delta declares ${ids.length} contract element(s) — ${named(ids)} — and its change.yaml classification does not set moduleContract. The classification is what decides which Flow may carry this Change, and it currently says no interface moves.`,
      refs: ids,
    });
  }
  if (elements.length === 0 && claimed) {
    observations.push({
      id: 'RC-7:empty-delta',
      rule: 'RC-7',
      code: 'XFORGE_RECONCILE_CONTRACT_DELTA_EMPTY',
      provenance: 'computed',
      summary: 'This Change classifies itself as moving a module contract, and its contract delta asserts that every section is empty. One of the two records is out of date.',
      refs: [],
    });
  }

  /*
   * The owning module against the Change's declared scope.
   *
   * `scope.modules` is what the Change says it touches, and the work-package write boundaries are
   * derived from it -- so an element owned by a module outside that scope means the packages will be
   * bounded by the narrower of two disagreeing statements. Only elements whose block actually names
   * a module are compared: `- module:` is a convention the Artifact instruction asks for rather than
   * a schema, and an absent convention is not a disagreement.
   */
  const inScope = new Set(scopeModules);
  const outside = [...new Set(elements.filter((element) => element.module && !inScope.has(element.module)).map((element) => element.module))].sort();
  for (const module of outside) {
    const affected = elements.filter((element) => element.module === module).map((element) => element.id).sort();
    observations.push({
      id: `RC-7:module:${module}`,
      rule: 'RC-7',
      code: 'XFORGE_RECONCILE_CONTRACT_MODULE_OUT_OF_SCOPE',
      provenance: 'computed',
      summary: `The contract delta says module ${module} owns ${named(affected)}, and this Change's scope.modules does not list ${module}. Work-package write boundaries are derived from scope.modules, so they would be drawn without it.`,
      refs: affected,
    });
  }
  return observations;
}
