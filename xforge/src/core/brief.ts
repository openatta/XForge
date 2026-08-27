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
import { flowArchiveOperation, flowArtifacts, isStageFlow, resolveChangeState } from './flow-resolver.js';
import { loadSelectedResources } from './resource-loader.js';
import { gateBlockReason, readGateEvidence, resolveControlPlane } from './control-plane.js';
import { codeMovedSince } from './revision.js';
import { CHECK_FINDINGS_PATH } from './check-findings.js';
import { CONSTITUTION_CHECK_PATH } from './constitution-check.js';
import { parseSpecDelta } from './spec-delta.js';
import { safeResolve } from './path-safety.js';
import { loadYaml } from './yaml.js';
export { requirementAnchor } from './brief/model.js';
import type {
  ArtifactSource, BriefUnavailable, LedgerFinding, LedgerPrinciple, MaterialDecision, ReconciliationObservation, SpecRequirement,
} from './brief/model.js';
import {
  dueArtifactIds, leadParagraph, readArtifactSources, readFindings, readMaterialDecisions, readPrinciples,
  readSpecRequirements,
} from './brief/sources.js';
import {
  reconcileCoverageSections, reconcileConstitutionReferences, reconcileDeclaredGaps, reconcileMaterialDecisions,
  reconcileRequirementAnchors, reconcileResolvedFindings,
} from './brief/reconcile.js';

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

type BriefProvenance = 'computed' | 'extracted' | 'authored';

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
  /**
   * A readable form for `--text`, when the generic renderer cannot produce one.
   *
   * `renderValue` handles a string, a flat list and a shallow record well, and falls back to
   * `JSON.stringify` for anything else. That fallback is how a change made *for* a human reader
   * reached them as a wall of JSON: the Gate provenance grouping exists so an approver can see at a
   * glance which staleness is accounted for, and it printed as one unbroken line of braces in the
   * only form an approver reads. An item that knows how it should read says so here.
   */
  text?: string[];
}


interface BriefApproval {
  policyId: string;
  transition: string;
  minApprovers: number;
  separationOfDuties: boolean;
  roles: string[];
  missing: number;
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
     *
     * `command` is what clears the entry, with this Change's id and this finding's id already
     * substituted. Naming the command in the surrounding prose was not enough: a live run read the
     * placeholders `--change <id> --id <finding-id>`, had three such entries in front of it, and
     * archived with all three still open. What a reader can run they run; what they have to
     * assemble first competes with signing and loses.
     */
    awaitingDecision: Array<{ id: string; summary: string; command: string }>;
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


/* Shared with the `structure` Gate so a marker locates the same text in both. */
const sections = documentSections;

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

/**
 * The Stage a Gate's Evidence is read as belonging to, from where the Change now stands.
 *
 * A Gate is not owned by one Stage: `solid` declares `structure` at propose, check and verify. The
 * one that matters is the latest Stage that declares it and that this Change has reached, because
 * that is the run whose Evidence the Change is currently living off — attributing `structure` to
 * propose while sitting at check would report it as long settled when the check exit turns on it.
 * `passed` is the separate question of whether every Stage declaring the Gate is now behind the
 * Change; `ready-to-archive` is synthetic and absent from `flow.stages`, so it sits past all of them.
 *
 * A Gate no Stage declares — a Gate resource the project selects and the Flow never asks for —
 * attributes to nothing and is never reported as expected: there is no Stage to explain it.
 */
function gateStage(flow: StageFlow, gateId: string, currentStage: string): { stage: string | null; passed: boolean } {
  const declaring = flow.stages
    .map((entry, index) => ({ id: entry.id, index, gates: [...(entry.gates ?? []), ...(entry.exit?.gates ?? [])] }))
    .filter((entry) => entry.gates.includes(gateId));
  if (declaring.length === 0) return { stage: null, passed: false };
  const currentIndex = flow.stages.findIndex((entry) => entry.id === currentStage);
  const position = currentIndex >= 0 ? currentIndex : flow.stages.length;
  const reached = declaring.filter((entry) => entry.index <= position);
  return {
    stage: (reached.at(-1) ?? declaring[0]!).id,
    passed: declaring.every((entry) => entry.index < position),
  };
}

/**
 * Stale Gates gathered under the Stage they belong to, each group saying whether its staleness is
 * accounted for.
 *
 * Expected means both halves: the Stage is behind the Change, *and* nothing at this position still
 * requires that Gate's Evidence to bind. Dropping the second half would have called the archive's
 * own mandatory Gates expected at `ready-to-archive`, which is the one place their staleness is the
 * whole question — the reassuring reading of the very Gates that must not be reassured about.
 */
function staleByStage(
  stale: ReadonlyArray<{ gate: string; stage: string | null; stagePassed: boolean }>,
  bindingGates: ReadonlySet<string>,
): Array<{ stage: string | null; gates: string[]; expected: boolean; why: string }> {
  const groups = new Map<string, { stage: string | null; stagePassed: boolean; gates: string[] }>();
  for (const entry of stale) {
    const group = groups.get(entry.stage ?? '') ?? { stage: entry.stage, stagePassed: entry.stagePassed, gates: [] };
    group.gates.push(entry.gate);
    groups.set(entry.stage ?? '', group);
  }
  return [...groups.values()].map((group) => {
    const binding = group.gates.filter((gate) => bindingGates.has(gate));
    if (binding.length > 0) {
      return {
        stage: group.stage,
        gates: group.gates,
        expected: false,
        why: `This Change still runs on ${binding.join(', ')}: the Evidence has to speak for the code as it stands, and the code has moved since it was produced.`,
      };
    }
    if (!group.stagePassed || group.stage === null) {
      return {
        stage: group.stage,
        gates: group.gates,
        expected: false,
        why: group.stage === null
          ? 'No Stage of this Flow declares these Gates, so nothing accounts for Evidence older than the code.'
          : `Stage ${group.stage} is not behind this Change, so its Evidence is not finished with.`,
      };
    }
    return {
      stage: group.stage,
      gates: group.gates,
      expected: true,
      why: `Stage ${group.stage} is closed and nothing here requires its Evidence to bind the current code; the code moved after it ran, which is what implementing the Change does.`,
    };
  });
}

/* ------------------------------------------------------------------ reconciliation rules */

interface BriefOptions {
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
   * Unresolved, and naming nowhere to go back to: by construction that is an item somebody has to
   * answer rather than route, and this Stage's approver is who the Artifact pointed it at.
   *
   * `status !== 'resolved'` matches the four other readers of this field in this file, and matters:
   * `flows/major.yaml` asks for `status` *only on blockers*, so an ordinary warning or suggestion
   * written to instruction carries none. Narrowing this to the literal `open` therefore emptied the
   * set of exactly the entries it exists to surface — `core/check-findings.ts` reads the same
   * absence as `open`, and two readers disagreeing about what a missing field means is how the
   * original defect got past everybody.
   *
   * The noise this was narrowed to avoid is handled where it actually came from: these no longer
   * make a brief applicable on their own. See `applicable` below.
   */
  const awaitingDecision = findingsResult.findings
    .filter((finding) => finding.status !== 'resolved' && !finding.reworkTo.trim())
    .map((finding) => ({
      id: finding.id,
      summary: finding.summary,
      /* The two values a reader would otherwise have to look up are the two this brief already
         knows. Only the answer and the name are left blank, and deliberately so: they are the
         person's, and a command carrying a plausible default for either is how an Agent ends up
         signing somebody else's decision — the same reason `verification declare --by` refuses to
         guess. Nothing here executes this string; it is printed. */
      command: `xforge findings resolve --change ${options.change} --id ${finding.id} --answer '<what you decided>' --by '<you>'`,
    }));

  /*
   * A brief is produced where a person has something to decide: an approval this Stage declares,
   * or a blocking finding somebody must route. Producing one at every Stage exit would answer the
   * complaint that started this feature — too much to read — with more to read.
   */
  /*
   * Deliberately not widened to `awaitingDecision`.
   *
   * Making an awaiting item summon a brief on its own sounded right and was the noise complaint:
   * such an entry is normally a non-blocking note that nothing ever resolves, so it forced a brief
   * at every Stage from then on — the "too much to read" outcome this gate exists to prevent. The
   * reported failure was never that these items could not summon a brief; it was that the briefs
   * approvers *did* read never mentioned them. Listing them in the decision block fixes that, and
   * a brief is still produced wherever somebody actually signs.
   */
  const applicable = approvals.length > 0 || openBlockers.length > 0;
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

  /*
   * What this position still turns on: the current Stage's own Gates, and at the synthetic
   * `ready-to-archive` the Gates archive requires, which `flowArchiveOperation` reads off the verify
   * Stage. This deliberately mirrors the control plane's own rule — it evaluates the Gates of the
   * current Stage and no others — so the brief cannot call a Gate settled that a transition would
   * still refuse.
   */
  const bindingGates = new Set(stage === 'ready-to-archive'
    ? flowArchiveOperation(flow).mandatoryGates
    : [...(stageDefinition?.gates ?? []), ...(stageDefinition?.exit?.gates ?? [])]);

  /*
   * What each Gate's Evidence was produced against, next to where the tree stands now.
   *
   * An approver reads this brief to decide whether the verification means anything, and the fact
   * that decides it was not on the page: Gate Evidence binds to the content revision, so it reports
   * as current while the code it exercised sits several merges behind. `sourceFilesChanged` counts
   * only files XForge did not write itself, so committing a Gate's own Evidence reads as zero and a
   * merged work package does not. `null` means it could not be established -- a rebase, a shallow
   * clone, no Git -- and is deliberately not shown as zero.
   *
   * Reported, not blocked on. Archive accepts Evidence bound to the current content revision and
   * that rule is unchanged here; this puts the difference in front of the person signing rather
   * than deciding for them.
   *
   * Grouped by Stage, because the flat list read as an audit defect where it was the ordinary
   * course of events. A `ready-to-archive` brief on a live run reported `staleAgainstCode:
   * ["check-findings", "constitution-check"]` against 43 source files moved since they ran, and
   * stopped the approver: both are Check-Stage Gates, the code moved during Apply — which is what
   * Apply is — and no rule at this point asks a closed Stage's Evidence to bind the current tree.
   * Only the Gates in `bindingGates` below are asked that. Listed side by side and undifferentiated,
   * the expected case and the one worth stopping for looked identical, so the approver either
   * investigates every archive or learns to wave the list through.
   */
  const gateProvenance = await Promise.all([...control.resources.gates.keys()].map(async (gateId) => {
    const evidence = await readGateEvidence(project, options.change, gateId, control.resources);
    if (!evidence) return null;
    const attribution = gateStage(flow, gateId, stage);
    return {
      gate: gateId,
      stage: attribution.stage,
      stagePassed: attribution.passed,
      status: evidence.status,
      ranAt: evidence.gitHead,
      sourceFilesChanged: await codeMovedSince(project, options.change, evidence.gitHead, governance.revision.gitHead),
    };
  }));
  const provenance = gateProvenance.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (provenance.length > 0) {
    const stale = provenance.filter((entry) => (entry.sourceFilesChanged ?? 0) > 0);
    const grouped = staleByStage(stale, bindingGates);
    const provenanceItem = item('computed.gates.provenance', 'computed', 'governance', 'Gate Evidence provenance', {
      currentGitHead: governance.revision.gitHead,
      gates: provenance,
      /* Unchanged, and kept whatever the grouping below says: it is the plain answer to "which Gates
         exercised code that has since moved", and narrowing it to the concerning ones would make a
         reader who asks that question get a different answer depending on where the Change stands. */
      staleAgainstCode: stale.map((entry) => entry.gate),
      staleByStage: grouped,
    });
    /*
     * Spelled out for `--text`, because that is the form an approver reads and the grouping exists
     * for them. Rendered generically it came out as a single line of JSON — the reassurance and the
     * warning equally unreadable, which is the state this whole item was meant to end.
     */
    provenanceItem.text = [
      `Current gitHead ${governance.revision.gitHead}.`,
      ...(stale.length === 0
        ? ['Every Gate\'s Evidence was produced against the code as it now stands.']
        : grouped.map((group) => `${group.expected ? 'Expected' : 'Look at this'} — ${group.stage ?? 'no Stage declares these'}: ${group.gates.join(', ')}. ${group.why}`)),
    ];
    computed.push(provenanceItem);
  }

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

  /*
   * Which Gates this Change has passed at the revision it stands at now, read from the Evidence on
   * disk rather than from `transitionRequirements`.
   *
   * `transitionRequirements` is keyed by the transitions legally available *from the current Stage*,
   * and `ready-to-archive` is not a Stage the Flow declares: `resolveControlPlane` finds no index
   * for it, enumerates no candidates, and returns an empty map. Every `gate:<name>` citation in the
   * Constitution ledger therefore resolved to nothing at exactly the moment a Change is archived,
   * and RC-5 reported a reconciliation no edit could clear -- `constitution-check` had already
   * accepted the same citation from the same Evidence, and re-running the Gate was impossible
   * because the synthetic Stage has none. A live Major closed carrying that observation.
   *
   * The revision comparison stays. Reading the Evidence the way `constitution-check` does, on status
   * alone, would have fixed the archive case by dropping the staleness check that makes RC-5's own
   * sentence true: "no Gate Evidence *for this revision*". `gateBlockReason` is the predicate the
   * control plane blocks on, and it is the one used here, so brief and the transition agree about
   * what "passed" means everywhere except the Stage that has no transitions left.
   *
   * The Gate itself is deliberately left revision-agnostic. `evidence/constitution-check.yaml` is a
   * declared Artifact output and so feeds the content revision; a Gate that demanded current-revision
   * Evidence for the Gates it cites would invalidate them by the act of writing its own ledger.
   */
  const gatePassed = new Set<string>();
  /*
   * What each Gate's Evidence recorded, separately from whether it counts as passed.
   *
   * `gatePassed` excludes a Gate for three different reasons — never ran, ran and failed, ran at an
   * older revision — and RC-5 has to tell them apart: "wait for it to run" is the wrong instruction
   * for a Gate that ran and failed, and it hides the failure while it is at it.
   */
  const gateRecorded = new Map<string, string>();
  for (const gateId of control.resources.gates.keys()) {
    const evidence = await readGateEvidence(project, options.change, gateId, control.resources);
    if (evidence) gateRecorded.set(gateId, evidence.status);
    if (!gateBlockReason(evidence, control.governance.revision.contentRevision)) gatePassed.add(gateId);
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
    ...reconcileConstitutionReferences(principlesResult.principles, requirements, sources, gatePassed, existingPaths, resolvesOnDisk, new Set(project.manifest.scaffold.gates ?? []), gateRecorded),
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
          : `Stage ${stage} has ${openBlockers.length} open blocking finding(s) somebody must route.`,
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
