import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type {
  ArtifactMarker,
  ChangeConfig,
  Diagnostic,
  ProjectContext,
  StageFlow,
  StageFlowArtifact,
} from '../types.js';
import { diagnostic } from './errors.js';
import { documentSections, markerOccurrences } from './artifact-markers.js';
import { flowArtifacts, isStageFlow, resolveChangeState } from './flow-resolver.js';
import { loadSelectedResources } from './resource-loader.js';
import { resolveControlPlane } from './control-plane.js';
import { CHECK_FINDINGS_PATH } from './check-findings.js';
import { CONSTITUTION_CHECK_PATH } from './constitution-check.js';
import { parseSpecDelta } from './spec-delta.js';
import { safeResolve } from './path-safety.js';
import { loadYaml } from './yaml.js';

/**
 * The decision brief: what a human needs in order to answer "should this Change pass this
 * approval", without reading the Artifacts themselves.
 *
 * The governing rule is that nothing here is a summary. Every entry declares where it came from:
 *
 * - `computed` — derived from structured data by code in this file. Re-running it against the same
 *   content revision produces the same bytes.
 * - `extracted` — a verbatim slice of an Artifact, located by a heading the Flow's `outline`
 *   already declares. Never reworded, always carrying its path and line.
 * - `authored` — a judgement written by a person or a model. Accepted only through
 *   `validateTriage`, and only when every entry cites `computed`/`extracted` ids that exist.
 *
 * The reason for the split is that the problem being solved is reading volume produced by an
 * Agent, and the obvious fix — have the Agent write a shorter version — makes the reviewer's
 * position worse rather than better: they would be reading the producing party's account of its
 * own output, in place of the output, with no way to tell which claims were checked. So the CLI
 * computes what can be computed, quotes what it cannot compute, and refuses to let an authored
 * claim float free of both.
 *
 * This module never calls a model and never writes a file.
 */

export type BriefProvenance = 'computed' | 'extracted' | 'authored';

export interface BriefItem {
  /** Stable within one brief, and the anchor an `authored` entry must cite. */
  id: string;
  provenance: BriefProvenance;
  group: string;
  label: string;
  value?: unknown;
  /** Project-relative source, present on every `extracted` item. */
  path?: string;
  line?: number;
  /** Required on `authored` items: ids of the entries the claim rests on. */
  basis?: string[];
}

export type ReconciliationRule = 'RC-1' | 'RC-2' | 'RC-3' | 'RC-4' | 'RC-5' | 'RC-6';

export interface ReconciliationObservation {
  id: string;
  rule: ReconciliationRule;
  code: string;
  provenance: 'computed';
  /** States the difference between two records. Never says whether it is a problem. */
  summary: string;
  refs: string[];
}

export interface BriefApproval {
  policyId: string;
  transition: string;
  minApprovers: number;
  separationOfDuties: boolean;
  roles: string[];
  missing: number;
}

export interface BriefUnavailable {
  section: string;
  code: string;
  reason: string;
}

export interface BriefData {
  change: string;
  flow: string;
  stage: string;
  contentRevision: string | null;
  decision: {
    /** False when this Stage has no human approval to give; the brief then carries no content. */
    applicable: boolean;
    reason: string;
    approvals: BriefApproval[];
    openBlockers: string[];
    /**
     * Open findings that name no Stage to go back to — the ones deferred to whoever signs here.
     *
     * They are structurally invisible otherwise. A blocker must name a `reworkTo` Stage, so an item
     * routed to the approver instead cannot be one; only blockers are enforced by the findings
     * Gate; and `openBlockers` above lists blockers alone. A live Major run left two of these open
     * through ten approvals, every one of whose `reason` read "good" — the questions were pointed
     * at the approver by name and never reached them.
     */
    awaitingDecision: Array<{ id: string; summary: string }>;
  };
  computed: BriefItem[];
  extracted: BriefItem[];
  reconciliation: ReconciliationObservation[];
  authored: BriefItem[];
  /**
   * Sections that could not be produced, and why. A brief that quietly drops a section it could
   * not read is at its most reassuring exactly when it is least entitled to be.
   */
  unavailable: BriefUnavailable[];
  /** What this brief structurally does not cover, so a reader knows what signing it does not mean. */
  notCovered: string[];
}

export interface BriefResult {
  data: BriefData;
  diagnostics: Diagnostic[];
}

const NOT_COVERED = [
  'Scenario bodies: only counted, never read.',
  'Narrative review prose (the Check report and any Clarifications).',
  'Artifact sections the active Flow does not declare in its outline.',
  'Whether the design is correct. This brief answers whether anything argues against passing it on.',
];

/**
 * A Requirement heading's citable id, on the same reading as `core/constitution-check.ts`:
 * `### Requirement: REQ-042 Widget works` cites as `REQ-042`.
 *
 * Unlike that reader, this one refuses a first token that is not id-shaped. Coverage rules search
 * for this string inside other documents, and a bare English word ("Widget") matches prose that
 * has nothing to do with the Requirement — which would report coverage that does not exist. When
 * no id-shaped token is present the full heading is the anchor: long, but never a false positive.
 */
const ID_SHAPED = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;

export function requirementAnchor(heading: string): string {
  const [first] = heading.trim().split(/\s+/);
  return first && ID_SHAPED.test(first) ? first : heading.trim();
}

interface SpecRequirement {
  anchor: string;
  heading: string;
  operation: string;
  file: string;
  line: number;
  scenarios: number;
}

interface ArtifactSource {
  id: string;
  /** Project-relative. */
  path: string;
  content: string;
  markers: ArtifactMarker[];
  /**
   * Whether a Stage at or before the current one produces this Artifact.
   *
   * A Change directory can hold a file the Flow does not expect yet — a stub written early, or one
   * left by a Stage this Change has since reworked away from. Auditing it at an earlier approval
   * reports absences that mean nothing: `assurance.md` does not name a Requirement at the design
   * approval because nobody has written the assurance yet, not because coverage is missing. Rules
   * that ask "does this section mention X" therefore run only against Artifacts that are due.
   */
  due: boolean;
}

/* Shared with the `structure` Gate so a marker locates the same text in both. */
const sections = documentSections;

/** The first non-empty paragraph of a section, which is where its claim is stated. */
function leadParagraph(body: string): string {
  const paragraphs = body.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** Artifact ids a Stage at or before `stage` produces. Everything, once past the last Stage. */
function dueArtifactIds(flow: StageFlow, stage: string): Set<string> {
  const index = flow.stages.findIndex((entry) => entry.id === stage);
  const reached = index < 0 ? flow.stages : flow.stages.slice(0, index + 1);
  return new Set(reached.flatMap((entry) => entry.produces));
}

async function readArtifactSources(
  project: ProjectContext,
  changeId: string,
  flow: StageFlow,
  stage: string,
): Promise<{ sources: ArtifactSource[]; unavailable: BriefUnavailable[] }> {
  const sources: ArtifactSource[] = [];
  const unavailable: BriefUnavailable[] = [];
  const due = dueArtifactIds(flow, stage);
  for (const artifact of flowArtifacts(flow) as StageFlowArtifact[]) {
    // Only single-file Artifacts are sliceable by heading; a glob such as the delta-Spec pattern
    // is counted by the Requirement reader below instead.
    if (artifact.generates.includes('*')) continue;
    const relative = `${project.changesPath}/${changeId}/${artifact.generates}`;
    try {
      const absolute = await safeResolve(project.root, relative);
      sources.push({
        id: artifact.id,
        path: relative,
        content: await readFile(absolute, 'utf8'),
        markers: artifact.markers ?? [],
        due: due.has(artifact.id),
      });
    } catch {
      /* A not-yet-written Artifact is the normal case for a later Stage, not a failure. Only an
         Artifact the current Stage already required would be missing here, and the Gates report
         that far more precisely than this brief could. */
    }
  }
  return { sources, unavailable };
}

async function readSpecRequirements(
  project: ProjectContext,
  changeId: string,
): Promise<{ requirements: SpecRequirement[]; unavailable: BriefUnavailable[] }> {
  const requirements: SpecRequirement[] = [];
  const unavailable: BriefUnavailable[] = [];
  const relative = `${project.changesPath}/${changeId}/specs`;
  let directory: string;
  try {
    directory = await safeResolve(project.root, relative);
  } catch {
    return { requirements, unavailable };
  }
  let files: string[] = [];
  try {
    files = (await fg('**/*.md', { cwd: directory, onlyFiles: true, followSymbolicLinks: false })).sort();
  } catch {
    unavailable.push({ section: 'scale', code: 'XFORGE_BRIEF_SPECS_UNREADABLE', reason: `Delta Spec directory could not be listed: ${relative}` });
    return { requirements, unavailable };
  }
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(path.join(directory, file), 'utf8');
    } catch {
      unavailable.push({ section: 'scale', code: 'XFORGE_BRIEF_SPEC_UNREADABLE', reason: `Delta Spec could not be read: ${relative}/${file}` });
      continue;
    }
    const parsed = parseSpecDelta(content);
    for (const section of parsed.sections) {
      for (const requirement of section.requirements) {
        requirements.push({
          anchor: requirementAnchor(requirement.name),
          heading: requirement.name,
          operation: section.operation,
          file: `${relative}/${file}`,
          line: requirement.line,
          scenarios: requirement.scenarios.length,
        });
      }
    }
    for (const requirement of parsed.orphanRequirements) {
      requirements.push({
        anchor: requirementAnchor(requirement.name),
        heading: requirement.name,
        operation: 'ORPHAN',
        file: `${relative}/${file}`,
        line: requirement.line,
        scenarios: requirement.scenarios.length,
      });
    }
  }
  return { requirements, unavailable };
}

interface LedgerFinding {
  id: string;
  severity: string;
  status: string;
  summary: string;
  refs: string[];
  reworkTo: string;
}

async function readFindings(
  project: ProjectContext,
  changeId: string,
): Promise<{ findings: LedgerFinding[]; present: boolean; unavailable: BriefUnavailable[] }> {
  const relative = `${project.changesPath}/${changeId}/${CHECK_FINDINGS_PATH}`;
  const unavailable: BriefUnavailable[] = [];
  let document: { findings?: unknown };
  try {
    document = await loadYaml<{ findings?: unknown }>(await safeResolve(project.root, relative), relative);
  } catch {
    return { findings: [], present: false, unavailable };
  }
  if (!Array.isArray(document.findings)) {
    unavailable.push({ section: 'findings', code: 'XFORGE_BRIEF_FINDINGS_UNREADABLE', reason: `Findings ledger has no findings list: ${relative}` });
    return { findings: [], present: true, unavailable };
  }
  const findings = document.findings.map((entry): LedgerFinding => {
    const value = (entry ?? {}) as Record<string, unknown>;
    const refs = Array.isArray(value.refs) ? value.refs.filter((item): item is string => typeof item === 'string') : [];
    return {
      id: typeof value.id === 'string' ? value.id : '(unnamed)',
      severity: typeof value.severity === 'string' ? value.severity : '(unset)',
      status: typeof value.status === 'string' ? value.status : '(unset)',
      summary: typeof value.summary === 'string' ? value.summary.trim() : '',
      refs,
      reworkTo: typeof value.reworkTo === 'string' ? value.reworkTo : '',
    };
  });
  return { findings, present: true, unavailable };
}

interface LedgerPrinciple {
  principle: string;
  status: string;
  references: string[];
  approvedBy: string;
}

/** Decided material questions that name where their decision has to be written back. */
async function readMaterialDecisions(project: ProjectContext, changeId: string): Promise<MaterialDecision[]> {
  for (const extension of ['yaml', 'yml', 'json']) {
    const relative = `${project.changesPath}/${changeId}/evidence/conditions/materialQuestions.${extension}`;
    let document: { entries?: unknown };
    try { document = await loadYaml<{ entries?: unknown }>(await safeResolve(project.root, relative), relative); }
    catch { continue; }
    if (!Array.isArray(document.entries)) return [];
    return document.entries.flatMap((entry): MaterialDecision[] => {
      const value = (entry ?? {}) as Record<string, unknown>;
      const revises = Array.isArray(value.revises) ? value.revises.filter((item): item is string => typeof item === 'string') : [];
      if (revises.length === 0 || typeof value.decision !== 'string') return [];
      return [{
        id: typeof value.id === 'string' ? value.id : '(unnamed)',
        decision: value.decision,
        decidedAt: typeof value.decidedAt === 'string' ? value.decidedAt : '',
        revises,
      }];
    });
  }
  return [];
}

async function readPrinciples(
  project: ProjectContext,
  changeId: string,
): Promise<{ principles: LedgerPrinciple[]; present: boolean; unavailable: BriefUnavailable[] }> {
  const relative = `${project.changesPath}/${changeId}/${CONSTITUTION_CHECK_PATH}`;
  const unavailable: BriefUnavailable[] = [];
  let document: { principles?: unknown };
  try {
    document = await loadYaml<{ principles?: unknown }>(await safeResolve(project.root, relative), relative);
  } catch {
    return { principles: [], present: false, unavailable };
  }
  if (!Array.isArray(document.principles)) {
    unavailable.push({ section: 'constitution', code: 'XFORGE_BRIEF_CONSTITUTION_UNREADABLE', reason: `Constitution ledger has no principles list: ${relative}` });
    return { principles: [], present: true, unavailable };
  }
  const principles = document.principles.map((entry): LedgerPrinciple => {
    const value = (entry ?? {}) as Record<string, unknown>;
    const references = Array.isArray(value.references) ? value.references.filter((item): item is string => typeof item === 'string') : [];
    return {
      principle: typeof value.principle === 'string' ? value.principle : '(unnamed)',
      status: typeof value.status === 'string' ? value.status : '(unset)',
      references,
      approvedBy: typeof value.approvedBy === 'string' ? value.approvedBy : '',
    };
  });
  return { principles, present: true, unavailable };
}

function item(
  id: string,
  provenance: BriefProvenance,
  group: string,
  label: string,
  value: unknown,
  location?: { path: string; line: number },
): BriefItem {
  return { id, provenance, group, label, value, ...(location ? { path: location.path, line: location.line } : {}) };
}

/* ------------------------------------------------------------------ reconciliation rules */

/**
 * RC-1 — a finding recorded as resolved whose cited Requirement is absent from the cited Artifact.
 *
 * The ledger's `status` is a word somebody typed; nothing in XForge has ever compared it against
 * the Artifact it claims to have changed. When the cited Artifact declares a
 * `requirement-coverage` marker, the search is narrowed to that section, because "add this to the
 * test strategy" is not satisfied by the Requirement appearing somewhere else in the document.
 */
function reconcileResolvedFindings(
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
function reconcileRequirementAnchors(
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
function reconcileCoverageSections(
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
function reconcileDeclaredGaps(
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

interface MaterialDecision {
  id: string;
  decision: string;
  decidedAt: string;
  revises: string[];
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
function reconcileMaterialDecisions(
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
function reconcileConstitutionReferences(
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

export interface BriefOptions {
  change: string;
  /** Triage entries to validate and attach, as parsed from `--attach-triage`. */
  triage?: unknown;
}

export function validateTriage(raw: unknown, anchors: Set<string>): { items: BriefItem[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const items: BriefItem[] = [];
  const entries = Array.isArray(raw) ? raw : (raw as { triage?: unknown } | null)?.triage;
  if (!Array.isArray(entries)) {
    return {
      items,
      diagnostics: [diagnostic('XFORGE_BRIEF_TRIAGE_MALFORMED', 'Triage input must be a list of entries, or an object with a `triage` list.')],
    };
  }
  for (const [index, entry] of entries.entries()) {
    const value = (entry ?? {}) as Record<string, unknown>;
    const label = typeof value.label === 'string' ? value.label.trim() : '';
    const basis = Array.isArray(value.basis) ? value.basis.filter((ref): ref is string => typeof ref === 'string') : [];
    if (!label) {
      diagnostics.push(diagnostic('XFORGE_BRIEF_TRIAGE_MALFORMED', `Triage entry ${index} has no label.`));
      continue;
    }
    /*
     * The whole point of the authored layer. A triage entry is allowed to say "look at this one
     * first"; it is not allowed to introduce a fact. Requiring every entry to name computed or
     * extracted ids that exist in this brief is what makes that structural instead of advisory:
     * an entry with no basis, or one citing an id the brief does not contain, is refused rather
     * than printed next to entries that were checked.
     */
    if (basis.length === 0) {
      diagnostics.push(diagnostic('XFORGE_BRIEF_UNANCHORED_CLAIM', `Triage entry "${label}" cites no basis. Every authored entry must cite at least one computed or extracted id from this brief.`));
      continue;
    }
    const unknown = basis.filter((ref) => !anchors.has(ref));
    if (unknown.length > 0) {
      diagnostics.push(diagnostic('XFORGE_BRIEF_UNANCHORED_CLAIM', `Triage entry "${label}" cites ids this brief does not contain: ${unknown.join(', ')}.`));
      continue;
    }
    items.push({
      id: `authored.triage.${index}`,
      provenance: 'authored',
      group: 'triage',
      label,
      value: typeof value.note === 'string' ? value.note.trim() : null,
      basis,
    });
  }
  return { items, diagnostics };
}

export async function readBrief(project: ProjectContext, options: BriefOptions): Promise<BriefResult> {
  const diagnostics: Diagnostic[] = [];
  const resolved = await resolveChangeState(project, options.change);
  diagnostics.push(...resolved.diagnostics);
  const config = resolved.config as ChangeConfig;

  if (!isStageFlow(resolved.flow) || !resolved.flow.governance) {
    return {
      data: {
        change: options.change,
        flow: resolved.flow.metadata.name,
        stage: '(none)',
        contentRevision: null,
        decision: {
          applicable: false,
          reason: 'This Change runs a Flow without governed Stages, so it has no approval for a brief to inform.',
          approvals: [],
          openBlockers: [],
          awaitingDecision: [],
        },
        computed: [],
        extracted: [],
        reconciliation: [],
        authored: [],
        unavailable: [],
        notCovered: NOT_COVERED,
      },
      diagnostics,
    };
  }

  const flow: StageFlow = resolved.flow;
  const resources = await loadSelectedResources(project);
  diagnostics.push(...resources.diagnostics);
  const control = await resolveControlPlane(project, options.change, flow, resolved.state, resources, config);
  diagnostics.push(...control.diagnostics);
  const governance = control.governance;
  const stage = governance.currentStage;

  const stageDefinition = flow.stages.find((entry) => entry.id === stage);
  const archiveApprovals = flow.terminal.archive.approvals ?? [];
  const stageApprovals = stageDefinition?.exit?.approvals ?? [];
  const declaredApprovals = stage === 'ready-to-archive' ? archiveApprovals : stageApprovals;
  const policies = flow.governance?.approvalPolicies ?? [];
  const approvals: BriefApproval[] = declaredApprovals.map((policyId) => {
    const policy = policies.find((entry) => entry.id === policyId);
    const pending = governance.pendingApprovals.find((entry) => entry.policyId === policyId);
    return {
      policyId,
      transition: pending?.transition ?? (stage === 'ready-to-archive' ? 'archive' : stage),
      minApprovers: policy?.minApprovers ?? 0,
      separationOfDuties: policy?.separationOfDuties ?? false,
      roles: policy?.roles ?? [],
      missing: pending?.missing ?? 0,
    };
  });

  const findingsResult = await readFindings(project, options.change);
  const openBlockers = findingsResult.findings
    .filter((finding) => finding.severity === 'blocker' && finding.status !== 'resolved')
    .map((finding) => finding.id);
  /*
   * Explicitly `open`, and naming nowhere to go back to: by construction that is an item somebody
   * has to answer rather than route, and this Stage's approver is who the Artifact pointed it at.
   *
   * `status !== 'resolved'` was too wide. `core/check-findings.ts` only reads `status` for blockers,
   * so an ordinary warning or suggestion usually carries none and `readFindings` defaults it to
   * `(unset)` — every such note then read as a question awaiting an answer and forced a brief at
   * every later Stage, which is the "too much to read" failure the applicable gate exists to stop.
   * An entry that never declared a status was not asking anybody anything.
   */
  const awaitingDecision = findingsResult.findings
    .filter((finding) => finding.status.trim() === 'open' && !finding.reworkTo.trim())
    .map((finding) => ({ id: finding.id, summary: finding.summary }));

  /*
   * A brief is produced where a person has something to decide: an approval this Stage declares,
   * or a blocking finding somebody must route. Producing one at every Stage exit would answer the
   * complaint that started this feature — too much to read — with more to read.
   */
  /* `awaitingDecision` counts here for the same reason the other two do: this file's rule is that a
     brief is produced where a person has something to decide, and an item that names no Stage to
     return to is waiting on a person's answer by construction. Leaving it out meant the one kind of
     item the Artifact had addressed to a human was the one kind that could not summon a brief. */
  const applicable = approvals.length > 0 || openBlockers.length > 0 || awaitingDecision.length > 0;
  if (!applicable) {
    return {
      data: {
        change: options.change,
        flow: flow.metadata.name,
        stage,
        contentRevision: governance.revision.contentRevision,
        decision: {
          applicable: false,
          reason: `Stage ${stage} declares no approval and has no open blocking finding; nothing here is a human decision.`,
          approvals: [],
          openBlockers: [],
          awaitingDecision: [],
        },
        computed: [],
        extracted: [],
        reconciliation: [],
        authored: [],
        unavailable: [],
        notCovered: NOT_COVERED,
      },
      diagnostics,
    };
  }

  const unavailable: BriefUnavailable[] = [...findingsResult.unavailable];
  const artifactResult = await readArtifactSources(project, options.change, flow, stage);
  unavailable.push(...artifactResult.unavailable);
  const specResult = await readSpecRequirements(project, options.change);
  unavailable.push(...specResult.unavailable);
  const principlesResult = await readPrinciples(project, options.change);
  unavailable.push(...principlesResult.unavailable);
  const sources = artifactResult.sources;
  const requirements = specResult.requirements;

  /* ---------------------------------------------------------------- computed */

  const computed: BriefItem[] = [];
  computed.push(item('computed.change.flow', 'computed', 'change', 'Flow', flow.metadata.name));
  computed.push(item('computed.change.stage', 'computed', 'change', 'Current Stage', stage));
  computed.push(item('computed.change.risk', 'computed', 'change', 'Risk', config.classification.risk));
  computed.push(item('computed.change.impacts', 'computed', 'change', 'Declared impacts', {
    security: config.classification.security,
    privacy: config.classification.privacy,
    publicApi: config.classification.publicApi,
    dataMigration: config.classification.dataMigration,
  }));
  computed.push(item('computed.change.scope', 'computed', 'change', 'Scope', { modules: config.scope.modules, paths: config.scope.paths }));

  const byOperation: Record<string, number> = {};
  const byFile: Record<string, { requirements: number; scenarios: number }> = {};
  let scenarioCount = 0;
  for (const requirement of requirements) {
    byOperation[requirement.operation] = (byOperation[requirement.operation] ?? 0) + 1;
    const bucket = byFile[requirement.file] ?? { requirements: 0, scenarios: 0 };
    bucket.requirements += 1;
    bucket.scenarios += requirement.scenarios;
    byFile[requirement.file] = bucket;
    scenarioCount += requirement.scenarios;
  }
  computed.push(item('computed.scale.requirements', 'computed', 'scale', 'Requirements', requirements.length));
  computed.push(item('computed.scale.scenarios', 'computed', 'scale', 'Scenarios', scenarioCount));
  computed.push(item('computed.scale.operations', 'computed', 'scale', 'Delta operations', byOperation));
  computed.push(item('computed.scale.perSpec', 'computed', 'scale', 'Per delta Spec', byFile));
  computed.push(item('computed.scale.artifacts', 'computed', 'scale', 'Written Artifacts', sources.map((source) => source.path)));

  if (findingsResult.present) {
    const counts = { blocker: 0, warning: 0, suggestion: 0 } as Record<string, number>;
    const openBySeverity = { blocker: 0, warning: 0, suggestion: 0 } as Record<string, number>;
    for (const finding of findingsResult.findings) {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
      if (finding.status !== 'resolved') openBySeverity[finding.severity] = (openBySeverity[finding.severity] ?? 0) + 1;
    }
    computed.push(item('computed.findings.counts', 'computed', 'findings', 'Findings by severity', counts));
    computed.push(item('computed.findings.open', 'computed', 'findings', 'Open by severity', openBySeverity));
    for (const finding of findingsResult.findings) {
      if (finding.status === 'resolved') continue;
      computed.push(item(`computed.findings.${finding.id}`, 'computed', 'findings', `Open ${finding.severity}: ${finding.id}`, {
        summary: finding.summary,
        refs: finding.refs,
        reworkTo: finding.reworkTo || null,
      }));
    }
  }

  if (principlesResult.present) {
    const statuses: Record<string, number> = {};
    for (const principle of principlesResult.principles) statuses[principle.status] = (statuses[principle.status] ?? 0) + 1;
    computed.push(item('computed.constitution.statuses', 'computed', 'constitution', 'Constitution principles', statuses));
    for (const principle of principlesResult.principles) {
      if (principle.status !== 'violation') continue;
      computed.push(item(`computed.constitution.violation.${principle.principle}`, 'computed', 'constitution', `Violation: ${principle.principle}`, {
        approvedBy: principle.approvedBy || null,
        references: principle.references,
      }));
    }
  }

  /* Already resolved by the control plane; re-reading the directory would only risk disagreeing
     with the Stage this brief just reported. */
  const receipts = governance.transitions;
  const timeline = receipts.map((receipt) => ({
    sequence: receipt.sequence,
    from: receipt.from,
    to: receipt.to,
    at: receipt.transitionedAt,
    actor: receipt.actor?.id ?? null,
    gitHead: receipt.gitHead,
  }));
  computed.push(item('computed.timeline.transitions', 'computed', 'timeline', 'Stage transitions', timeline));
  const backward = receipts.filter((receipt) => {
    const order = flow.stages.map((entry) => entry.id);
    return order.indexOf(receipt.to) >= 0 && order.indexOf(receipt.from) > order.indexOf(receipt.to);
  }).length;
  computed.push(item('computed.timeline.rework', 'computed', 'timeline', 'Backward transitions', backward));
  const heads = [...new Set(receipts.map((receipt) => receipt.gitHead).filter(Boolean))];
  /*
   * One Git head across every transition means no product code has been written under this
   * Change yet — which is precisely what makes a pre-implementation approval cheap to refuse and
   * expensive to grant carelessly. It is the single most decision-relevant fact available here and
   * nothing else in the CLI surfaces it.
   */
  computed.push(item('computed.timeline.gitHeads', 'computed', 'timeline', 'Distinct Git heads across transitions', heads));

  computed.push(item('computed.governance.approvals', 'computed', 'governance', 'Approvals required here', approvals));
  computed.push(item('computed.governance.auditChain', 'computed', 'governance', 'Audit chain', {
    valid: governance.audit.chainValid,
    events: governance.audit.eventCount,
    coverageGaps: governance.audit.coverageGaps,
  }));

  /* ---------------------------------------------------------------- extracted */

  const extracted: BriefItem[] = [];
  for (const source of sources) {
    /* Quoting a Stage's Artifact before that Stage has run presents a stub as if it were the
       author's position. */
    if (!source.due) continue;
    const parsed = sections(source.content);
    const declared = source.content ? [...parsed.keys()] : [];
    for (const heading of declared) {
      const section = parsed.get(heading)!;
      const lead = leadParagraph(section.body);
      if (!lead) continue;
      extracted.push(item(
        `extracted.${source.id}.${heading}`,
        'extracted',
        source.id,
        heading,
        lead,
        { path: source.path, line: section.line },
      ));
    }
    for (const marker of source.markers) {
      const section = parsed.get(marker.section);
      if (!section) continue;
      /* Verbatim, from the marker onward: this is the sentence the author wrote about why an
         option was rejected, not a restatement of it. */
      for (const [index, occurrence] of markerOccurrences(section, marker).entries()) {
        extracted.push(item(
          `extracted.${source.id}.${marker.id}.${index + 1}`,
          'extracted',
          `${source.id}:${marker.role}`,
          marker.section,
          occurrence.text,
          { path: source.path, line: occurrence.line },
        ));
      }
    }
  }

  /* ---------------------------------------------------------------- reconciliation */

  const gatePassed = new Set<string>();
  for (const transition of control.transitionRequirements.values()) {
    for (const gate of transition.gates) {
      if (gate.status === 'passed') gatePassed.add(gate.gate);
    }
  }

  const existingPaths = new Set<string>();
  for (const source of sources) {
    existingPaths.add(source.path);
    existingPaths.add(source.path.slice(`${project.changesPath}/${options.change}/`.length));
  }
  for (const requirement of requirements) {
    existingPaths.add(requirement.file);
    existingPaths.add(requirement.file.slice(`${project.changesPath}/${options.change}/`.length));
  }

  /*
   * The same two spellings `constitution-check.ts`'s `resolveReference` tries, resolved here so RC-5
   * agrees with the Gate that already accepted these citations. Done once for the whole principle
   * set rather than inside the pure reconciliation function, which stays synchronous and testable.
   */
  const resolvesOnDisk = new Set<string>();
  for (const principle of principlesResult.principles) {
    for (const reference of principle.references) {
      if (/^gate:/i.test(reference) || resolvesOnDisk.has(reference)) continue;
      for (const candidate of [`${project.changesPath}/${options.change}/${reference}`, reference]) {
        try {
          await access(await safeResolve(project.root, candidate));
          resolvesOnDisk.add(reference);
          break;
        } catch { /* try the next spelling */ }
      }
    }
  }

  const reconciliation: ReconciliationObservation[] = [
    ...reconcileResolvedFindings(findingsResult.findings, requirements, sources),
    ...reconcileRequirementAnchors(requirements, sources),
    ...reconcileCoverageSections(requirements, sources),
    ...reconcileDeclaredGaps(sources, findingsResult.findings),
    ...reconcileConstitutionReferences(principlesResult.principles, requirements, sources, gatePassed, existingPaths, resolvesOnDisk),
    ...reconcileMaterialDecisions(await readMaterialDecisions(project, options.change), sources),
  ];

  /* ---------------------------------------------------------------- authored */

  const anchors = new Set([...computed, ...extracted].map((entry) => entry.id));
  for (const observation of reconciliation) anchors.add(observation.id);
  let authored: BriefItem[] = [];
  if (options.triage !== undefined) {
    const triage = validateTriage(options.triage, anchors);
    authored = triage.items;
    diagnostics.push(...triage.diagnostics);
  }

  return {
    data: {
      change: options.change,
      flow: flow.metadata.name,
      stage,
      contentRevision: governance.revision.contentRevision,
      decision: {
        applicable: true,
        reason: approvals.length > 0
          ? `Stage ${stage} cannot be left without ${approvals.map((entry) => entry.policyId).join(', ')}.`
          : openBlockers.length > 0
            ? `Stage ${stage} has ${openBlockers.length} open blocking finding(s) somebody must route.`
            /* Applicable on an awaiting item alone: "0 open blocking findings" led with a false
               count and the wrong category of work. */
            : `Stage ${stage} has ${awaitingDecision.length} open item(s) awaiting an answer.`,
        approvals,
        openBlockers,
        awaitingDecision,
      },
      computed,
      extracted,
      reconciliation,
      authored,
      unavailable,
      notCovered: NOT_COVERED,
    },
    diagnostics,
  };
}
