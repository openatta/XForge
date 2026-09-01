import { readFile, readdir } from 'node:fs/promises';
import type { ApprovalReceipt, ProjectContext, TransitionReceipt } from '../types.js';
import { safeResolve } from './path-safety.js';
import { commitAuthors } from './revision.js';
import { TRANSITION_RECEIPTS_RELATIVE } from './control-plane/receipts.js';

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
  /**
   * Lower-cased actor ids from this Change's transition receipts. **Never** accepted as an identity.
   *
   * A transition receipt's actor is whoever ran `xforge transition` — in an agent-driven session
   * that is the Agent, under the OS username it happens to run as, and admitting it would let an
   * Agent name itself as the decider of anything. That is the one thing `resolvedBy`, `decidedBy`
   * and `approvedBy` exist to prevent, so this set is collected for one purpose only: when a refused
   * name matches it, the refusal can say *why* a name that plainly appears in the Change's own
   * records is not one of the identities this checks against. It widens the explanation and never
   * the acceptance.
   */
  actors: Set<string>;
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
  return { values, empty: values.size === 0, actors: await transitionActors(project, changeId) };
}

/**
 * The actor ids on this Change's transition receipts, read leniently and used only to explain.
 *
 * Deliberately not `readTransitionReceiptFiles`: that validates schema, digest and subject, and
 * needs a resolved Flow to do it. None of that rigour is owed here, because nothing this returns can
 * make a name acceptable — a forged, malformed or foreign receipt can at most cause a refusal to
 * offer one more sentence about a name that is being refused either way. A failure to read is
 * silence, for the same reason.
 */
async function transitionActors(project: ProjectContext, changeId: string): Promise<Set<string>> {
  const actors = new Set<string>();
  const relative = `${project.changesPath}/${changeId}/${TRANSITION_RECEIPTS_RELATIVE}`;
  try {
    const directory = await safeResolve(project.root, relative);
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const receipt = JSON.parse(await readFile(await safeResolve(project.root, `${relative}/${name}`), 'utf8')) as TransitionReceipt;
        add(actors, receipt.actor?.id);
      } catch { continue; }
    }
  } catch { return actors; }
  return actors;
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
/**
 * Whether the repository has ever seen this name, for a record that belongs to the project rather
 * than to one Change.
 *
 * `knownIdentities` answers the Change-scoped question and is the right bar for `decidedBy`,
 * `resolvedBy` and `approvedBy`. `xforge verification declare` writes no Change: it records who
 * decided how this project verifies itself, into the governed Manifest, and every later Gate run
 * trusts that command. It took any string at all and said nothing — a live run recorded
 * `--by 'Nobody Who Exists'` and got `ok: true` with an empty diagnostics list, while the ledger
 * written in the same Stage refused a `decidedBy` the repository could not attest.
 *
 * Reported rather than refused, and the distinction is deliberate. A legitimate declaration is
 * routinely attributed to somebody with no commits here — a role a person answered as, an owner
 * named in a request document, someone new. Refusing those would trade a silent record for a
 * blocked one. What was wrong was the silence: the Manifest now carries the name either way, and a
 * reader is told which names the repository can stand behind.
 */
export async function unattestedDeclarer(root: string, name: string): Promise<string | null> {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  const authors = new Set(await commitAuthors(root, []));
  if (authors.size === 0) return null;
  if (authors.has(normalized)) return null;
  const match = /^(.*?)\s*<(.+)>$/.exec(normalized);
  if (match && (authors.has(match[1]!.trim()) || authors.has(match[2]!.trim()))) return null;
  return `"${name.trim()}" is not a Git author of this repository, so the record of who decided this cannot be checked against anything. It is kept as written; a reader should know it is unattested.`;
}

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
  /*
   * The name appears in the Change's records, as the actor who ran a transition — said out loud.
   *
   * Without this the refusal reads as "that name is not here", which is false and unactionable: it
   * is here, thirteen times, on every transition receipt. What it is not is an *attested* identity.
   * A transition receipt records which process moved the Stage; an approval receipt and a Git commit
   * record a person taking responsibility, and those are the two this checks against.
   */
  const asActor = known.actors.has(normalized)
    ? ' It is the actor on this Change\'s transition receipts, which record which process ran the command rather than who decided; only an approver on an approval receipt or a Git author of this Change counts here.'
    : '';
  const listed = `${[...known.values].slice(0, 4).join(', ')}${known.values.size > 4 ? ', …' : ''}`;
  return `does not match any approver or Git author this Change records (${listed})${asActor}`;
}
