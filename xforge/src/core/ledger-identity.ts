import { readFile, readdir } from 'node:fs/promises';
import type { ApprovalReceipt, ProjectContext, TransitionReceipt } from '../types.js';
import { safeResolve } from './path-safety.js';
import { commitAuthors } from './revision.js';
import { loadSelectedResources } from './resource-loader.js';
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
  /**
   * Every Git author of the repository, used only when `values` is empty and `managed` is true.
   *
   * Not a widening of the bar. `values` stays the bar in every case where it can be applied; this
   * is what the empty case is checked against instead of being waved through, and it is the same
   * set `unattestedDeclarer` already holds a `verification declare --by` to.
   */
  fallback: Set<string>;
  /**
   * Whether this project collects approvals through a provider that is actually wired up.
   *
   * The strictness of the empty case follows this and nothing else. A project approving at the
   * terminal is doing a manual job — a person types a name, and no amount of checking makes that
   * more than a person typing a name — so the empty case stays permissive there and is reported.
   * A project whose approvals go through a configured provider is under a managed chain, and a
   * governance ledger inside it is checked from the first entry rather than from the first commit.
   *
   * "Configured" is answered from the project first and the environment second, because the two
   * are not equally reliable and the environment is the weaker one. The shipped
   * `enterprise-approvals` McpServer carries a `command` that names itself as unconfigured, so a
   * provider whose command is no longer that sentinel is one somebody pointed at a real system —
   * a fact about the project, identical for every command run against it. The token holding a value
   * says the same thing about the moment rather than the project, and is kept as a second signal.
   *
   * Reading the token alone was wrong, and the live-engine harness is what showed it: it sets
   * `XFORGE_ENTERPRISE_APPROVALS_TOKEN` on the `xforge approve` spawn and on nothing else, so a
   * project whose every approval goes through a real MCP provider answered `false` on every
   * `check` and `state` — failing open, silently, in exactly the deployment the strict branch
   * exists for. A signal that depends on which command happens to be running is not a property of
   * the project.
   *
   * A fresh install still answers `false`: the default Manifest registers the provider, its
   * McpServer is the placeholder, and no token is set.
   */
  managed: boolean;
}

function add(target: Set<string>, value: string | undefined | null): void {
  const normalized = value?.trim().toLowerCase();
  if (normalized) target.add(normalized);
}

/**
 * Whether this project's approvals run through a provider that is actually configured.
 *
 * Split in two on purpose. The *names* of the token variables come from the Manifest and the
 * McpServer specs, which cannot change inside one process, so they are memoised per project root
 * and the resource load is paid once. The environment is read fresh every time: memoising the
 * answer instead would be right for a one-shot CLI and wrong everywhere the same root is asked
 * twice under different environments, which is exactly what a test does — and a cache that is only
 * correct because production happens not to exercise it is a cache that hides its own bug.
 *
 * The cheap exit comes first: a project registering no provider at all never loads a resource.
 */
const approvalProvidersByRoot = new Map<string, Promise<{ wired: boolean; tokenEnv: string[] }>>();

/**
 * The command the shipped placeholder McpServer carries, which is its way of saying it is a
 * placeholder. Matched as a whole argv entry rather than by substring: a real server whose path
 * happens to contain this word is not the placeholder.
 */
const UNCONFIGURED_SENTINEL = 'xforge-enterprise-approvals-server-not-configured';

async function approvalProviderFacts(project: ProjectContext): Promise<{ wired: boolean; tokenEnv: string[] }> {
  const providers = (project.manifest.approvals?.providers ?? []).filter((provider) => provider.type === 'mcp');
  if (providers.length === 0) return { wired: false, tokenEnv: [] };
  const cached = approvalProvidersByRoot.get(project.root);
  if (cached) return cached;
  const resolved = (async () => {
    /* A resource that will not load is not a configured provider; `checker.ts` reports that
       separately and this must not turn it into strictness nobody asked for. */
    const resources = await loadSelectedResources(project).catch(() => null);
    if (!resources) return { wired: false, tokenEnv: [] };
    const tokenEnv: string[] = [];
    let wired = false;
    for (const provider of providers) {
      const spec = resources.mcpServers.get(provider.mcpServer)?.value.spec;
      if (!spec) continue;
      if (spec.authTokenEnv) tokenEnv.push(spec.authTokenEnv);
      /* An http transport has no command at all, and reaching one is itself the configuration. */
      if (!(spec.command ?? []).includes(UNCONFIGURED_SENTINEL)) wired = true;
    }
    return { wired, tokenEnv };
  })();
  approvalProvidersByRoot.set(project.root, resolved);
  return resolved;
}

async function managedApprovals(project: ProjectContext): Promise<boolean> {
  const facts = await approvalProviderFacts(project);
  /* Project state first; the environment is the second answer to the same question, kept because a
     project may point at a real system in a way this cannot read. Either one is enough. */
  return facts.wired || facts.tokenEnv.some((variable) => (process.env[variable] ?? '').trim().length > 0);
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
  const empty = values.size === 0;
  const managed = await managedApprovals(project);
  /* Only read where it is used. A Change with identities of its own is checked against those, and
     an unmanaged project never consults the fallback, so neither pays for this walk. */
  const fallback = new Set<string>();
  if (empty && managed) for (const author of await commitAuthors(project.root, [])) {
    add(fallback, author);
    const match = /^(.*?)\s*<(.+)>$/.exec(author);
    if (match) { add(fallback, match[1]); add(fallback, match[2]); }
  }
  return { values, empty, actors: await transitionActors(project, changeId), fallback, managed };
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
  /* Under a managed chain the empty case was checked, against the repository's own authors, so
     there is no provisional pass to disclose. Silence here is the accurate report. */
  if (known.managed && known.fallback.size > 0) return null;
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
  if (known.empty) {
    /*
     * The empty case, decided by how this project collects approvals rather than by its history.
     *
     * Terminal approval is a manual act: a person types a name into a prompt, and holding the
     * ledger beside it to a stricter bar buys nothing a person cannot walk around anyway. So that
     * project keeps the permissive path and the disclosure that goes with it.
     *
     * A project whose approvals run through a configured provider is not doing that job by hand,
     * and the provisional pass there is a real trap: the same bytes pass now and are refused after
     * the Change's first commit, with the Stage's report already written on the strength of the
     * pass. The repository's own authors are what the name is checked against instead — which is
     * exactly what it would be checked against a commit later, only in time to be useful.
     *
     * A repository with no commits at all still passes. Nothing is being compared there, and the
     * first Change in a new repository must not be blocked for the repository being new.
     */
    if (!known.managed || known.fallback.size === 0) return null;
    if (known.fallback.has(normalized)) return null;
    const match = /^(.*?)\s*<(.+)>$/.exec(normalized);
    if (match && (known.fallback.has(match[1]!.trim()) || known.fallback.has(match[2]!.trim()))) return null;
    const listed = `${[...known.fallback].slice(0, 4).join(', ')}${known.fallback.size > 4 ? ', …' : ''}`;
    return `does not match any Git author of this repository (${listed}). This Change records no approver and no commit of its own yet, so there is nothing Change-scoped to check against; this project collects approvals through a configured provider, so the name is held to the repository's authors now rather than accepted and refused after the first commit`;
  }
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
