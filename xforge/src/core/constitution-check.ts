import { access, readFile } from 'node:fs/promises';
import type { ProjectContext } from '../types.js';
import { safeResolve } from './path-safety.js';
import { loadYaml } from './yaml.js';
import { knownIdentities, unknownIdentityReason, type KnownIdentities } from './ledger-identity.js';

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
 */
export const CONSTITUTION_CHECK_PATH = 'evidence/constitution-check.yaml';

export type PrincipleStatus = 'compliant' | 'violation' | 'not-applicable';

const STATUSES: PrincipleStatus[] = ['compliant', 'violation', 'not-applicable'];

export interface ConstitutionCheckResult {
  status: 'passed' | 'failed';
  problems: string[];
  principles: string[];
  covered: string[];
  violations: string[];
}

/** The `## ` headings of the Constitution, in document order. The `# ` title is not a principle. */
export function constitutionPrinciples(content: string): string[] {
  return [...content.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]!.trim()).filter(Boolean);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function evaluateConstitutionCheck(project: ProjectContext, changeId: string, known?: KnownIdentities): Promise<ConstitutionCheckResult> {
  const relative = `${project.changesPath}/${changeId}/${CONSTITUTION_CHECK_PATH}`;
  const principles = constitutionPrinciples(project.constitution.content);
  const empty = (problems: string[]): ConstitutionCheckResult => ({ status: 'failed', problems, principles, covered: [], violations: [] });

  if (principles.length === 0) {
    return empty([`${project.constitution.path}: no "## " principle sections found; the Constitution cannot be checked against.`]);
  }

  let absolute: string;
  try { absolute = await safeResolve(project.root, relative); }
  catch { return empty([`${relative}: path is outside the project.`]); }
  try { await access(absolute); }
  catch {
    return empty([`${relative}: record one entry per Constitution principle (${principles.length} in ${project.constitution.path}). A general claim of compliance does not satisfy this Gate.`]);
  }
  if ((await readFile(absolute, 'utf8')).trim().length === 0) return empty([`${relative}: the Constitution ledger is empty.`]);

  let document: { principles?: unknown };
  try { document = await loadYaml<{ principles?: unknown }>(absolute, relative); }
  catch (error) { return empty([`${relative}: ${(error as Error).message}`]); }
  if (!document || typeof document !== 'object' || !Array.isArray(document.principles)) {
    return empty([`${relative}: expected a top-level "principles" list.`]);
  }

  const problems: string[] = [];
  const covered: string[] = [];
  const violations: string[] = [];
  const byName = new Map<string, Record<string, unknown>>();

  for (const [index, raw] of document.principles.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = text(entry.principle);
    if (!name) { problems.push(`${relative}: entry #${index + 1} does not name a principle.`); continue; }
    const match = principles.find((candidate) => normalize(candidate) === normalize(name));
    if (!match) {
      problems.push(`${relative}: "${name}" is not a principle in ${project.constitution.path}; the Constitution may have been amended.`);
      continue;
    }
    if (byName.has(match)) { problems.push(`${relative}: principle "${match}" is answered twice.`); continue; }
    byName.set(match, entry);
  }

  for (const principle of principles) {
    const entry = byName.get(principle);
    if (!entry) { problems.push(`${relative}: principle "${principle}" is not answered.`); continue; }
    covered.push(principle);
    const status = text(entry.status) as PrincipleStatus;
    if (!STATUSES.includes(status)) {
      problems.push(`${relative}: principle "${principle}" has status "${text(entry.status) || '(none)'}"; expected one of ${STATUSES.join(', ')}.`);
      continue;
    }
    /* A deviation is allowed, but only as a recorded, reasoned decision — never as a silent one. */
    if (status === 'violation') {
      violations.push(principle);
      if (!text(entry.justification)) problems.push(`${relative}: principle "${principle}" is declared a violation with no justification.`);
      const approvedBy = text(entry.approvedBy);
      if (!approvedBy) problems.push(`${relative}: a Constitution violation needs a named approver in approvedBy; principle "${principle}" has none.`);
      else {
        const reason = known && unknownIdentityReason(approvedBy, known);
        if (reason) problems.push(`${relative}: principle "${principle}" is approved by "${approvedBy}", which ${reason}.`);
      }
    }
    if (status === 'not-applicable' && !text(entry.justification)) {
      problems.push(`${relative}: principle "${principle}" is marked not-applicable with no justification.`);
    }
  }

  return { status: problems.length === 0 ? 'passed' : 'failed', problems, principles, covered, violations };
}
