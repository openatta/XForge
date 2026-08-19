import type { ApprovalReceipt, ProjectContext } from '../types.js';
import { commitAuthors } from './revision.js';

/**
 * Whether a name written into a governance ledger refers to somebody this project has actually seen.
 *
 * `decidedBy` / `approvedBy` used to be satisfied by any non-empty string, which is a very weak bar
 * for the one field whose whole job is to stop a decision from being anonymous: a live run produced
 * `decidedBy: XForge Live E2E`, and `the team` would have passed just as easily. Requiring the name
 * to match an identity the repository already records — an approver on a receipt, or a Git author —
 * means an Agent cannot invent a decision-maker, only cite one.
 *
 * Deliberately permissive in two ways. It accepts a Git author's display name as well as their
 * email, because humans write ledgers by name; and it accepts any approver on any receipt for the
 * Change, not just the current policy's, because the person who decided a clarification is often
 * not the person who signs the closing approval.
 */
export interface KnownIdentities {
  /** Lower-cased identities: approver ids, Git author emails, and Git author display names. */
  values: Set<string>;
  /** True when the project has no recorded identities at all (fresh Change, no commits, no receipts). */
  empty: boolean;
}

function add(target: Set<string>, value: string | undefined | null): void {
  const normalized = value?.trim().toLowerCase();
  if (normalized) target.add(normalized);
}

export async function knownIdentities(
  project: ProjectContext,
  changeId: string,
  receipts: ApprovalReceipt[],
): Promise<KnownIdentities> {
  const values = new Set<string>();
  for (const receipt of receipts) add(values, receipt.approver.id);
  const changeDirectory = `${project.changesPath}/${changeId}`;
  /* `%an <%ae>` gives both forms; a ledger may cite either. */
  for (const author of await commitAuthors(project.root, ['--', changeDirectory])) {
    add(values, author);
    const match = /^(.*?)\s*<(.+)>$/.exec(author);
    if (match) { add(values, match[1]); add(values, match[2]); }
  }
  return { values, empty: values.size === 0 };
}

/**
 * The caveat a caller must state when a ledger passed this check without one being possible.
 *
 * `null` once the Change records at least one identity — the check ran and means something. Non-null
 * while the identity set is empty, which is a real condition with a real consequence: the same file,
 * unchanged, passes now and fails after the Change's first commit, because the commit is what
 * creates the set to compare against.
 *
 * That is the intended design — see `unknownIdentityReason` for why a new repository must not have
 * its first Change blocked — and it was silent, which is the part that misled. A live run watched
 * two mandatory Gates report `passed`, wrote the Check report on the strength of it, committed, and
 * then had the identical content refused. "Green" there did not mean the names were good; it meant
 * nothing yet existed that could say they were bad. Callers surface this so a reader can tell those
 * two states apart before, rather than after, building on one.
 */
export function unverifiableIdentityWarning(known: KnownIdentities): string | null {
  if (!known.empty) return null;
  return 'this Change records no approvers and has no commits yet, so the names in it could not be checked against anything; they will be checked after the first commit, and a name that does not match a Git author or approver then will fail this Gate';
}

/**
 * `null` when the name is acceptable, otherwise the reason it is not.
 *
 * When the project records no identities at all there is nothing to check against, so a non-empty
 * name is accepted rather than blocking a Change that simply has no history yet — failing there
 * would punish the first Change in a repository for the repository being new. `unverifiableIdentityWarning`
 * is the disclosure that goes with that acceptance.
 */
export function unknownIdentityReason(name: string, known: KnownIdentities): string | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return 'is empty';
  if (known.empty) return null;
  if (known.values.has(normalized)) return null;
  /* Tolerate "Name <email>" written where only one form is recorded. */
  const match = /^(.*?)\s*<(.+)>$/.exec(normalized);
  if (match && (known.values.has(match[1]!.trim()) || known.values.has(match[2]!.trim()))) return null;
  return `does not match any approver or Git author this Change records (${[...known.values].slice(0, 4).join(', ')}${known.values.size > 4 ? ', …' : ''})`;
}
