import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { ApprovalReceipt, ProjectContext } from '../types.js';
import { verdict, type LedgerVerdict } from './ledger.js';
import { safeResolve } from './path-safety.js';
import { loadYaml, trimmedText } from './yaml.js';
import { knownIdentities, unknownIdentityReason, unverifiableIdentityWarning, type KnownIdentities } from './ledger-identity.js';

/**
 * Makes the Constitution the enforced first layer it is documented to be.
 *
 * Before this, the Constitution was read into `xforge state`, digested into `policySnapshotDigest`,
 * and named in every Skill — but nothing ever checked an Artifact against it. "Complies with the
 * Constitution" was a sentence an Agent could write.
 *
 * The ledger cannot be satisfied by a blanket assurance: the principles are the `## ` sections of
 * the project's own `constitution.md`, so every one must be named and answered. Amending the
 * Constitution therefore invalidates the ledger of every in-flight Change, which is the point — a
 * new principle has to be considered by work that is already underway.
 *
 * Answering is not the same as complying, though, and the first version of this Gate only checked
 * the former: `status: compliant` required nothing else, so a ledger of seven bare `compliant`
 * lines passed. That upgraded "one sentence an Agent could write" to "seven labelled sentences an
 * Agent could write. Two things close that gap, in ascending order of strength:
 *
 * 1. **A compliant answer must cite something machine-locatable** (`references`): a Requirement id
 *    declared by this Change's delta Specs, a path that actually exists, or `gate:<name>` for a
 *    Gate this Change has passing Evidence for. This does not prove the citation supports the
 *    claim — the same honest limit `check-findings`' `refs` check states about itself — but it does
 *    mean every principle was answered while looking at a specific, checkable artifact, and a
 *    ledger nobody can trace back to anything is rejected outright.
 * 2. **Where the CLI already knows the answer, it checks rather than asks.** Two principles have a
 *    machine-visible truth: the observability principle is contradicted by failing `unit-tests`
 *    Gate Evidence, and the self-approval principle is contradicted by an exception approved by
 *    somebody who does not appear on any approval receipt this Change actually holds. Neither
 *    fires speculatively — a Change that has not run its tests yet (Check runs long before Verify)
 *    or holds no receipts yet is not penalised for evidence that does not exist.
 */
export const CONSTITUTION_CHECK_PATH = 'evidence/constitution-check.yaml';

type PrincipleStatus = 'compliant' | 'violation' | 'not-applicable';

const STATUSES: PrincipleStatus[] = ['compliant', 'violation', 'not-applicable'];

/** How a `references` entry resolved, for diagnostics. `null` means it resolved to nothing. */
type ReferenceKind = 'gate' | 'path' | 'requirement';

/**
 * An approval receipt this Change holds, by the filename `core/approval-receipt.ts` writes.
 *
 * Such a path resolves — the file is right there — which is exactly the problem. A receipt records
 * that somebody approved a transition; it says nothing about *why* this Change satisfies a
 * principle. A principle answered `compliant` on a receipt alone therefore cites evidence of a
 * decision in place of evidence of compliance, and the Gate's existing checks cannot tell the
 * difference because the citation is perfectly locatable.
 *
 * It is not a hypothetical: for a principle *about governance* a receipt is the evidence a Check
 * Agent naturally reaches for, and two consecutive recorded live runs cited only that.
 */
const APPROVAL_RECEIPT_REFERENCE = /(?:^|\/)approvals\/[^/]+\/[0-9a-f-]{36}\.json$/i;

interface ConstitutionCheckResult extends LedgerVerdict {
  principles: string[];
  covered: string[];
  violations: string[];
}

/** The `## ` headings of the Constitution, in document order. The `# ` title is not a principle. */
export function constitutionPrinciples(content: string): string[] {
  return [...content.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]!.trim()).filter(Boolean);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(trimmedText).filter(Boolean);
  const single = trimmedText(value);
  return single ? [single] : [];
}

/**
 * What this Change can be cited against: the Gates it has passing Evidence for, and the Requirement
 * names its delta Specs and the project's canonical Specs declare. Both are read once per
 * evaluation and reused across every entry.
 */
interface CitableFacts {
  /** Gate name -> latest recorded status, from the Change's own `evidence/*.json`. */
  gates: Map<string, string>;
  /**
   * Every Gate this project has selected, whether or not it has run.
   *
   * Carried so a citation that cannot be resolved can say *why*. `gate:unit-tests` written into the
   * ledger at the Check Stage names a Gate that runs at Verify: there is no Evidence yet, and the
   * same citation resolves later, at archive, where this ledger is re-decided. Reporting that
   * identically to `gate:no-such-thing` is what led a live run to abandon the citation form
   * altogether rather than move the citation.
   */
  declaredGates: Set<string>;
  /** Lower-cased Requirement heading text, plus its leading id token when the heading has one. */
  requirements: Set<string>;
}

async function readGateEvidence(project: ProjectContext, changeId: string): Promise<Map<string, string>> {
  const gates = new Map<string, string>();
  let directory: string;
  try { directory = await safeResolve(project.root, `${project.changesPath}/${changeId}/evidence`); }
  catch { return gates; }
  let names: string[] = [];
  try { names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(); }
  catch { return gates; }
  for (const name of names) {
    try {
      const evidence = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as { gate?: unknown; status?: unknown };
      const gate = trimmedText(evidence.gate);
      const status = trimmedText(evidence.status);
      if (gate && status) gates.set(gate, status);
    } catch { /* Unreadable Evidence is the Gate runner's problem to report, not this ledger's. */ }
  }
  return gates;
}

async function readRequirements(project: ProjectContext, changeId: string): Promise<Set<string>> {
  const requirements = new Set<string>();
  const roots = [`${project.changesPath}/${changeId}/specs`, project.specsPath];
  for (const relative of roots) {
    let directory: string;
    try { directory = await safeResolve(project.root, relative); }
    catch { continue; }
    let files: string[] = [];
    try { files = await fg('**/*.md', { cwd: directory, onlyFiles: true, followSymbolicLinks: false }); }
    catch { continue; }
    for (const file of files) {
      let content: string;
      try { content = await readFile(path.join(directory, file), 'utf8'); }
      catch { continue; }
      for (const match of content.matchAll(/^###\s+Requirement:\s*(.+?)\s*$/gm)) {
        const heading = match[1]!.trim();
        if (!heading) continue;
        requirements.add(normalize(heading));
        /* `### Requirement: REQ-042 Widget works` — the id alone is the usual citation form. */
        const [first] = heading.split(/\s+/);
        if (first) requirements.add(normalize(first));
      }
    }
  }
  return requirements;
}

/**
 * Why one citation did not resolve, in the terms its author can act on.
 *
 * The three cases need three different actions and used to read the same. A Gate this project does
 * not have is a typo. A Gate it has that has not run yet is a *timing* problem -- the ledger is
 * written at Check and this Gate runs at Verify -- and the citation will resolve when this same
 * ledger is re-decided at archive, so the answer is to cite something available now or to move the
 * citation, not to abandon the form. Anything else is a path or Requirement that is simply absent.
 */
function describeDangling(reference: string, facts: CitableFacts): string {
  const gate = /^gate:(.+)$/i.exec(reference);
  if (!gate) return reference;
  const name = gate[1]!.trim();
  if (!facts.declaredGates.has(name)) return `${reference} (this project selects no Gate by that name)`;
  const status = facts.gates.get(name);
  if (status === undefined) return `${reference} (that Gate is selected but has produced no Evidence yet — it runs at a later Stage than the one this ledger is written at, and the citation resolves once it has)`;
  return `${reference} (that Gate ran and recorded ${status}, not passed)`;
}

async function resolveReference(
  project: ProjectContext,
  changeId: string,
  reference: string,
  facts: CitableFacts,
): Promise<ReferenceKind | null> {
  const gateMatch = /^gate:(.+)$/i.exec(reference);
  if (gateMatch) {
    const name = gateMatch[1]!.trim();
    return facts.gates.get(name) === 'passed' ? 'gate' : null;
  }
  if (facts.requirements.has(normalize(reference))) return 'requirement';
  /* Change-relative first (the form every other ledger uses), then project-relative. */
  for (const candidate of [`${project.changesPath}/${changeId}/${reference}`, reference]) {
    try {
      await access(await safeResolve(project.root, candidate));
      return 'path';
    } catch { /* try the next spelling */ }
  }
  return null;
}

/** The observability principle names automated verification; `unit-tests` is the Gate that proves it. */
function isObservabilityPrinciple(principle: string): boolean {
  return /observab|automated verification|test/i.test(principle);
}

/**
 * Approvers this Change actually holds a receipt from, lower-cased. Only `approve` decisions count:
 * a rejection is not somebody signing off on an exception.
 */
function receiptApprovers(receipts: ApprovalReceipt[]): Set<string> {
  const approvers = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.decision !== 'approve') continue;
    const id = trimmedText(receipt.approver?.id);
    if (id) approvers.add(id.toLowerCase());
  }
  return approvers;
}

function citesApprovalReceipt(name: string, approvers: Set<string>): boolean {
  const normalized = name.trim().toLowerCase();
  if (approvers.has(normalized)) return true;
  const match = /^(.*?)\s*<(.+)>$/.exec(normalized);
  return Boolean(match && (approvers.has(match[1]!.trim()) || approvers.has(match[2]!.trim())));
}

interface ConstitutionCheckOptions {
  /**
   * Approval receipts this Change holds. Supplied by callers that already loaded them; when
   * omitted the receipts are read from disk, so the Gate behaves the same either way.
   */
  approvals?: ApprovalReceipt[];
}

export async function evaluateConstitutionCheck(
  project: ProjectContext,
  changeId: string,
  known?: KnownIdentities,
  options: ConstitutionCheckOptions = {},
): Promise<ConstitutionCheckResult> {
  const relative = `${project.changesPath}/${changeId}/${CONSTITUTION_CHECK_PATH}`;
  const principles = constitutionPrinciples(project.constitution.content);
  const empty = (problems: string[]): ConstitutionCheckResult => ({ ...verdict(problems), principles, covered: [], violations: [] });

  if (principles.length === 0) {
    return empty([`${project.constitution.path}: no "## " principle sections found; the Constitution cannot be checked against.`]);
  }

  let absolute: string;
  try { absolute = await safeResolve(project.root, relative); }
  catch { return empty([`${relative}: path is outside the project.`]); }
  try { await access(absolute); }
  catch {
    return empty([`${relative}: record one entry per Constitution principle (${principles.length} in ${project.constitution.path}), each citing at least one machine-locatable reference. A general claim of compliance does not satisfy this Gate.`]);
  }
  if ((await readFile(absolute, 'utf8')).trim().length === 0) return empty([`${relative}: the Constitution ledger is empty.`]);

  let document: { principles?: unknown };
  try { document = await loadYaml<{ principles?: unknown }>(absolute, relative); }
  catch (error) { return empty([`${relative}: ${(error as Error).message}`]); }
  if (!document || typeof document !== 'object' || !Array.isArray(document.principles)) {
    return empty([`${relative}: expected a top-level "principles" list.`]);
  }

  const problems: string[] = [];
  const warnings: string[] = [];
  const covered: string[] = [];
  const violations: string[] = [];
  /** Every `approvedBy` checked here, so a pass reached with nothing to check against can say so. */
  const approvedNames: string[] = [];
  const byName = new Map<string, Record<string, unknown>>();

  for (const [index, raw] of document.principles.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = trimmedText(entry.principle);
    if (!name) { problems.push(`${relative}: entry #${index + 1} does not name a principle.`); continue; }
    const match = principles.find((candidate) => normalize(candidate) === normalize(name));
    if (!match) {
      problems.push(`${relative}: "${name}" is not a principle in ${project.constitution.path}; the Constitution may have been amended.`);
      continue;
    }
    if (byName.has(match)) { problems.push(`${relative}: principle "${match}" is answered twice.`); continue; }
    byName.set(match, entry);
  }

  const facts: CitableFacts = {
    gates: await readGateEvidence(project, changeId),
    declaredGates: new Set(project.manifest.scaffold.gates ?? []),
    requirements: await readRequirements(project, changeId),
  };
  const approvals = options.approvals ?? (await loadReceipts(project, changeId));
  const approvers = receiptApprovers(approvals);
  let citedAnything = false;

  for (const principle of principles) {
    const entry = byName.get(principle);
    if (!entry) { problems.push(`${relative}: principle "${principle}" is not answered.`); continue; }
    covered.push(principle);
    const status = trimmedText(entry.status) as PrincipleStatus;
    if (!STATUSES.includes(status)) {
      problems.push(`${relative}: principle "${principle}" has status "${trimmedText(entry.status) || '(none)'}"; expected one of ${STATUSES.join(', ')}.`);
      continue;
    }

    /*
     * A compliant answer is the one status that asserts something about this Change without owing
     * a justification, so it is the one that has to be traceable. Every reference is resolved; an
     * entry passes on the first one that resolves, and a dangling reference is named individually
     * so the fix is obvious.
     */
    const references = list(entry.references);
    const resolved: string[] = [];
    const dangling: string[] = [];
    for (const reference of references) {
      if (await resolveReference(project, changeId, reference, facts)) resolved.push(reference);
      else dangling.push(reference);
    }
    if (resolved.length > 0) citedAnything = true;
    if (status === 'compliant') {
      if (references.length === 0) {
        problems.push(`${relative}: principle "${principle}" is answered compliant with no references; cite at least one machine-locatable reference — a Requirement id from this Change's delta Specs, a path that exists, or gate:<name> for a Gate this Change has passed.`);
      } else if (resolved.length === 0) {
        problems.push(`${relative}: principle "${principle}" cites only references this project cannot locate (${dangling.map((reference) => describeDangling(reference, facts)).join('; ')}); a citation nobody can follow is not evidence of compliance.`);
      } else if (resolved.every((reference) => APPROVAL_RECEIPT_REFERENCE.test(reference))) {
        /*
         * Every citation resolves, and none of them is evidence. Refused here rather than left to
         * the Skill's wording because this codebase has already run that experiment: the hazard was
         * documented, nothing acted on it, and it recurred. A rule an Agent is asked to remember is
         * not the same rule as one the Gate applies.
         */
        problems.push(`${relative}: principle "${principle}" cites only approval receipts (${resolved.join(', ')}); a receipt records that someone approved a transition, not why this Change satisfies the principle. Cite a Requirement id, a governed Artifact, or gate:<name> as well.`);
      } else if (dangling.length > 0) {
        warnings.push(`${relative}: principle "${principle}" cites ${dangling.join(', ')}, which this project cannot locate.`);
      }
      /* The CLI does not have to take an Agent's word for this one: the Gate already ran. */
      if (isObservabilityPrinciple(principle)) {
        const unitTests = facts.gates.get('unit-tests');
        if (unitTests && unitTests !== 'passed') {
          problems.push(`${relative}: principle "${principle}" is answered compliant, but this Change's unit-tests Gate Evidence records status "${unitTests}". Automated verification that does not pass does not establish compliance.`);
        } else if (!unitTests) {
          warnings.push(`${relative}: principle "${principle}" could not be cross-checked — this Change has no unit-tests Gate Evidence yet. It will be checked again once the Gate has run.`);
        }
      }
    }

    /* A deviation is allowed, but only as a recorded, reasoned decision — never as a silent one. */
    if (status === 'violation') {
      violations.push(principle);
      if (!trimmedText(entry.justification)) problems.push(`${relative}: principle "${principle}" is declared a violation with no justification.`);
      const approvedBy = trimmedText(entry.approvedBy);
      if (!approvedBy) problems.push(`${relative}: a Constitution violation needs a named approver in approvedBy; principle "${principle}" has none.`);
      else if (approvers.size > 0 && !citesApprovalReceipt(approvedBy, approvers)) {
        /*
         * "No Agent may approve its own exception" is only meaningful if the approver is somebody
         * the project can show actually approved something. Once this Change holds approval
         * receipts, an exception attributed to anyone not on one of them is an assertion, not a
         * decision. Before the first receipt exists — Check runs ahead of every approval Stage —
         * the weaker known-identity test below is all there is to check against, and blocking there
         * would make recording a violation at Check impossible.
         */
        problems.push(`${relative}: principle "${principle}" is approved by "${approvedBy}", who holds no approval receipt for this Change (${[...approvers].slice(0, 4).join(', ')}). An exception must be approved by someone who actually decided it.`);
      } else {
        approvedNames.push(approvedBy);
        const reason = known && unknownIdentityReason(approvedBy, known);
        if (reason) problems.push(`${relative}: principle "${principle}" is approved by "${approvedBy}", which ${reason}.`);
      }
    }

    if (status === 'not-applicable' && !trimmedText(entry.justification)) {
      problems.push(`${relative}: principle "${principle}" is marked not-applicable with no justification.`);
    }
  }

  /*
   * Stated separately from the per-entry problems because it is a different failure: not "this
   * answer is unsupported" but "this whole ledger is a blanket claim of compliance", which is
   * exactly what the Gate exists to reject.
   */
  if (!citedAnything && violations.length === 0) {
    problems.push(`${relative}: no entry in this ledger cites anything; a ledger of bare statuses is the general claim of compliance this Gate replaces.`);
  }

  /* The same disclosure `check-findings` makes, for the same reason: an approvedBy accepted against
     an empty identity set was not verified, and the first commit turns that pass into a failure. */
  const unverifiable = approvedNames.length > 0 && known ? unverifiableIdentityWarning(known) : null;
  if (unverifiable) {
    warnings.push(`${relative}: ${approvedNames.length} approvedBy name(s) (${approvedNames.join(', ')}) were accepted without verification — ${unverifiable}.`);
  }

  return { ...verdict(problems, warnings), principles, covered, violations };
}

/**
 * Imported lazily so this module stays usable from the Gate runner without pulling the whole
 * control plane into every caller's module graph.
 */
async function loadReceipts(project: ProjectContext, changeId: string): Promise<ApprovalReceipt[]> {
  try {
    const { loadApprovalReceipts } = await import('./control-plane.js');
    return (await loadApprovalReceipts(project, changeId)).receipts;
  } catch {
    return [];
  }
}
