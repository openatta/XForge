import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic } from '../types.js';
import { diagnostic } from './errors.js';
import { UPGRADE_SENTINEL } from './ownership-zones.js';

/**
 * Reading the marker an unfinished upgrade leaves behind, from every command that is not the upgrade.
 *
 * The staged copy used to be the notice. `xforge/scaffold-<version>/` sat beside the project's own
 * Scaffold and was visible on purpose, on the argument that a half-finished upgrade should be
 * obvious in a file listing rather than hidden in a dotfile. That directory moves to
 * `xforge/.upgrade/`, so the argument needs a different carrier: one file, `xforge/UPGRADING.md`,
 * written when the upgrade is staged and removed when `--complete` or `--rollback` closes it.
 *
 * A file listing was never the reader that mattered most, though. Whoever stages an upgrade knows
 * they staged it. The failure is the run three commands later, by somebody who does not: a
 * `transition` that advances a Stage under Gates and a Flow sitting part-way between two releases,
 * or a `doctor` whose findings are the unfinished merge showing through rather than anything wrong
 * with the project. Both read as facts about the project and neither says the word "upgrade". So
 * the commands that have an opinion about the Scaffold say that one is open, in the diagnostics they
 * were already going to print.
 *
 * ## What the file contains
 *
 * The contract is stated here because this is the side that has to survive the file being written
 * differently than intended. The versions below are deliberately fabricated rather than real
 * releases: an illustrative span that happens to be a shipped version collides with the release
 * guard's "these files still name the previous version" check on every bump, and answering that
 * with an exemption would trade a one-line example for a permanent entry in a second list.
 *
 *     # Scaffold upgrade in progress
 *
 *     - From: 4.1.0
 *     - To: 4.2.0
 *
 *     Finish the merge, then run `xforge upgrade-scaffold --complete`. To abandon it and restore
 *     the 4.1.0 Scaffold, run `xforge upgrade-scaffold --rollback`.
 *
 * Two facts are load-bearing — the version span and the two commands that close the upgrade — and
 * only the span is read out of the file. The commands are stated by this module instead, because
 * the sentinel is a Markdown file sitting in a tree an Agent is mid-merge in, and a marker that can
 * tell a reader which command to run is a marker that can send them to the wrong one.
 *
 * Everything else in the file is prose for a person and the parse steps over it. The fields are
 * found by scanning lines for a label, never by position, so a heading, a summary of what was
 * staged, or a note somebody added during the merge changes nothing about what is read.
 */

export interface StagedUpgrade {
  /** The version the project is coming from, or null where the marker does not say. */
  fromVersion: string | null;
  /** The version being installed, or null where the marker does not say. */
  toVersion: string | null;
}

/* A label, a colon and a version, with any list marker or quoting a Markdown writer puts around
   them: `- From: 4.1.0`, `To: 4.2.0`, `  * to: 4.3.0` all read the same. */
const VERSION_FIELD = /^[\s>*+-]*(from|to)\s*:\s*[`'"]?([A-Za-z0-9][^\s`'"]*?)[`'"]?\s*$/i;

/** `4.1.0 → 4.2.0`, which is the shape a heading takes if the writer puts the span in one. */
const VERSION_SPAN = /([0-9][^\s`]*)\s*(?:→|->)\s*([0-9][^\s`]*)/;

/**
 * `unknown` is not a version.
 *
 * `stage()` writes that literal whenever the Manifest carries no Scaffold pin to read, so it is a
 * value the marker legitimately holds. Passing it through would print "from unknown to 4.2.0",
 * which reads as a version a person could go and look up. Reporting the absence is the honest form
 * of the same fact.
 */
const stated = (token: string): string | null => (/^unknown$/i.test(token) ? null : token);

/**
 * What the marker says, tolerant of everything around it.
 *
 * Split from the read so that "the file said nothing this understands" is a case with a name, and
 * one a test can produce without arranging a filesystem to misbehave.
 */
export function parseStagedUpgrade(content: string): StagedUpgrade {
  let fromVersion: string | null = null;
  let toVersion: string | null = null;
  for (const line of content.split('\n')) {
    const field = VERSION_FIELD.exec(line);
    if (!field) continue;
    const version = stated(field[2]!);
    /* First statement wins per label, and a `null` does not count as one: a marker whose `From:`
       says `unknown` and which names the real version further down should be read as naming it. */
    if (field[1]!.toLowerCase() === 'from') fromVersion ??= version;
    else toVersion ??= version;
  }
  if (fromVersion === null && toVersion === null) {
    const span = VERSION_SPAN.exec(content);
    if (span) {
      fromVersion = stated(span[1]!);
      toVersion = stated(span[2]!);
    }
  }
  return { fromVersion, toVersion };
}

/**
 * The upgrade that is open, or null when none is.
 *
 * Three states on disk collapse into two answers, and where that line falls is the whole of this
 * function. The *fact* that an upgrade is open comes from the read: the file was there and its
 * bytes were legible. The *detail* comes from the parse, and losing the detail is survivable — a
 * warning that cannot name the versions still stops a reader, where no warning at all does not. So
 * a marker that is present and says nothing this can understand is reported as an upgrade in flight
 * with an unknown span. The marker exists precisely for the case where things are half-finished,
 * and a mangled marker is that case arriving.
 *
 * A path that cannot be read at all falls on the other side and answers null. A directory at the
 * sentinel's path, or a permission that refuses it, is not evidence that an upgrade is open; it is
 * the absence of evidence either way, and announcing a staged upgrade on the strength of a failed
 * read would put the warning on projects that never staged one — which today is every project on
 * disk, since nothing writes this file yet.
 *
 * Neither case throws. No command in this product exists to check on the sentinel; each one is
 * doing something else and asking on the way past, so a `doctor` that dies on the file that was
 * supposed to warn you is a worse outcome than the warning going missing.
 */
export async function readStagedUpgrade(root: string): Promise<StagedUpgrade | null> {
  let content: string;
  try {
    content = await readFile(path.join(root, ...UPGRADE_SENTINEL.split('/')), 'utf8');
  } catch {
    return null;
  }
  return parseStagedUpgrade(content);
}

/** The trees an unfinished merge leaves in an indeterminate state — the `managed-source` zone. */
const MANAGED_TREES = 'the Scaffold, the Flows and the Scripts';

/** The opening sentence: what is in flight, said as precisely as the marker allows. */
function stagedSpan(staged: StagedUpgrade): string {
  if (staged.fromVersion && staged.toVersion) {
    return `A Scaffold upgrade from ${staged.fromVersion} to ${staged.toVersion} is staged and has not been closed, so ${MANAGED_TREES} are part-way between the two.`;
  }
  if (staged.toVersion) {
    return `A Scaffold upgrade to ${staged.toVersion} is staged and has not been closed, so ${MANAGED_TREES} are part-way between two releases.`;
  }
  if (staged.fromVersion) {
    return `A Scaffold upgrade away from ${staged.fromVersion} is staged and has not been closed, so ${MANAGED_TREES} are part-way between two releases.`;
  }
  return `A Scaffold upgrade is staged and has not been closed: ${UPGRADE_SENTINEL} is here and does not record which versions it spans, so ${MANAGED_TREES} are part-way between two releases and nothing on disk says which.`;
}

/**
 * The one warning, worded once for the four commands that raise it.
 *
 * Built here rather than at each call site because four hand-written accounts of one fact become
 * four accounts that disagree, and the disagreement surfaces as a reader trusting whichever command
 * they happened to run. What varies between commands is the `hazard`: what *this* command is about
 * to do under a half-merged Scaffold. What closes the upgrade does not vary, so it is said the same
 * way everywhere.
 *
 * A warning, never a refusal. `stage()` already refuses to open an upgrade while a Change is
 * unarchived, so this state was entered deliberately by somebody who was told. Refusing here would
 * lock that person inside the half-finished merge — unable to run `check` to see what the merge
 * broke, or `doctor` to find out what is dangling — which is a worse failure than letting them
 * proceed knowing where they are.
 */
export function upgradeInProgressDiagnostic(staged: StagedUpgrade, hazard?: string): Diagnostic {
  return diagnostic(
    'XFORGE_UPGRADE_IN_PROGRESS',
    `${stagedSpan(staged)}${hazard ? ` ${hazard}` : ''} Finish the merge and run \`xforge upgrade-scaffold --complete\`, or \`xforge upgrade-scaffold --rollback\` to abandon it and restore the Scaffold this project had before.`,
    UPGRADE_SENTINEL,
    'warning',
  );
}
