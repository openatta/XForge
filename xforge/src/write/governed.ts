import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProjectContext } from '../types.js';
import { atomicWrite } from '../core/files.js';
import { safeResolve } from '../core/path-safety.js';

/**
 * Write a governed record and record that it happened, or leave the tree exactly as it was.
 *
 * Seven call sites wrote this sequence by hand — `transition`, `approve`, `review`,
 * `work-package dispatch`, `work-package acknowledge`, and both `verification` declarations — and
 * their comments name each other ("same as dispatch/transition/approve"), which is what a rule
 * being copied rather than shared looks like. They had drifted into three different unwinds and two
 * different moments for resolving the path.
 *
 * **Why the record and the event cannot come apart.** Every reader in this product that reasons
 * from one of these files requires the chain to corroborate it: `approvalVerifiedInChain` trusts an
 * approval receipt only once a matching `approval.decided` event exists, `readAcknowledgementAttestations`
 * counts nothing the chain does not attest, and `readTransitionAttestations` does the same for a
 * transition. A record written without its event is therefore not a partial success — it is a file
 * that every later command reports as a forgery for something that genuinely happened, and for the
 * uuid-named ones no retry replaces it, so it accumulates.
 *
 * **One rule for the unwind, and it reproduces all five that were written by hand.** Put back
 * exactly what was there before: nothing, if the path did not exist, which is the `rm` that
 * `transition` / `approve` / `review` / `dispatch` each wrote; the previous bytes, if it did, which
 * is `acknowledge` restoring a superseded receipt rather than deleting somebody else's attested
 * evidence, and `verification` restoring a Manifest whose declaration list would otherwise gain a
 * duplicate on retry. Those looked like different policies. They are one policy meeting different
 * starting states.
 */

/* Not exported: callers pass an object literal, and the suite refuses a module that exports a
   symbol nothing outside it names. `Parameters<typeof governedWrite>[1]` reaches it if needed. */
interface GovernedWrite {
  /** Repository-relative path of the record. */
  path: string;
  content: string;
  /**
   * `exclusive` refuses when something is already at the path, instead of replacing it.
   *
   * For a record whose name is derived from a sequence rather than from a uuid, a second writer is
   * never a write to merge: the Transition receipt at sequence N *is* the record that the Change
   * moved once at that point, so a second one is a conflict to report. `link()` says both things at
   * once — atomic, so the content is complete before the name exists, and `EEXIST` rather than an
   * overwrite of a receipt the rest of the chain already hashes.
   */
  mode?: 'replace' | 'exclusive';
  /**
   * What makes the write real: normally the `recordAudit` call, and anything else that must succeed
   * with it. Throwing here undoes the write. A failure from the write itself is *not* unwound — it
   * never landed, and `exclusive`'s `EEXIST` is a diagnosis its caller owns.
   */
  record: () => Promise<unknown>;
}

/**
 * Raised when `exclusive` found somebody already at the path.
 *
 * A distinct type rather than the raw `EEXIST`, because the caller that interprets it runs its
 * `record` step inside this call too — and the audit chain takes its lock with `mkdir`, which fails
 * with `EEXIST` of its own. Matching on the code alone would let a lock contention be reported as
 * "a receipt for this sequence already exists", which sends a reader to look for a receipt that is
 * not there. This says which phase failed, and only the write phase can raise it.
 */
export class GovernedWriteConflict extends Error {
  constructor(readonly path: string, override readonly cause: unknown) {
    super(`A record already exists at ${path}.`);
    this.name = 'GovernedWriteConflict';
  }
}

/** Creates a file at exactly one path, or fails because somebody was already there. */
async function createExclusive(destination: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.xforge-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await link(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function governedWrite(project: ProjectContext, write: GovernedWrite): Promise<void> {
  /*
   * Resolved first, and the order is load bearing.
   *
   * Four of the five hand-written unwinds called `safeResolve` inside their own catch block. If
   * that resolution throws, the failure that reaches the caller is about a path rather than about
   * the audit write that actually failed — and the orphan the unwind exists to remove is still
   * there. `review.ts` was the one that hoisted it, and said why in a comment; the other four did
   * not. Reading the prior state below requires the resolved path anyway, so here there is no
   * version of this that resolves late.
   */
  const destination = await safeResolve(project.root, write.path, { createParent: true });
  const prior = await readFile(destination).catch(() => null);

  if (write.mode === 'exclusive') {
    try {
      await createExclusive(destination, write.content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new GovernedWriteConflict(write.path, error);
      throw error;
    }
  } else await atomicWrite(project.root, write.path, write.content);

  try {
    await write.record();
  } catch (error) {
    /* The unwind's own failure must never replace the reason the write is being unwound. */
    if (prior === null) await rm(destination, { force: true }).catch(() => undefined);
    else await atomicWrite(project.root, write.path, prior.toString('utf8')).catch(() => undefined);
    throw error;
  }
}
