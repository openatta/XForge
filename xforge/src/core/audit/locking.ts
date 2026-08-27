import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { ProjectContext } from '../../types.js';
import { XForgeError, diagnostic } from '../errors.js';
import { rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { safeResolve } from '../path-safety.js';
import { AUDIT_DIRECTORY } from '../../constants.js';

/* From `constants.ts`, not from `core/audit.ts`: the lock is what makes the append safe, so it must
   not depend on the module whose appends it protects. That constraint is about the *appending*
   module, and it is why this string used to be copied here — but a constants module has no
   dependencies to invert, and three private copies of one governed path is how a rename moves two
   of them and leaves a lock nobody contends for. */
const LOCK_DIRECTORY = `${AUDIT_DIRECTORY}/.locks`;
const GLOBAL_SHARD_KEY = '_global';
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_OWNER_FILE = 'owner.json';
const heldLocks = new Set<string>();
let exitCleanupRegistered = false;


/**
 * Exclusive access to one audit shard, for the duration of an append.
 *
 * The chain is a file whose every entry names the hash of the one before it, so two processes
 * appending at once do not produce a merge conflict -- they produce a chain that no longer verifies,
 * and the damage is only visible later, to somebody who did not cause it. A directory create is the
 * primitive because it is atomic on every filesystem this runs on.
 *
 * A lock is reclaimable, and that is deliberate: a process killed mid-append would otherwise leave
 * the shard permanently unwritable. Reclaiming is bounded by the owner still being alive and by a
 * TTL, and it records which of the two let it through.
 */

/**
 * Who holds an append lock, written inside the lock directory itself.
 *
 * The lock is a `mkdir` mutex, which is atomic on every filesystem XForge targets but carries no
 * information: a bare directory cannot say whether its creator is still alive. XForge installs no
 * signal handlers (deliberately — a library that traps SIGINT changes the host process's exit
 * semantics), so Node's default disposition terminates without running `appendEvent`'s `finally`.
 * One Ctrl-C, agent-harness SIGTERM or CI container eviction while the lock is held therefore used
 * to poison *every* later command that records an audit event for that Change — `check`,
 * `transition`, `approve`, `archive`, `work-package`, every `xforge hook` call — with no way to
 * recover short of deleting a directory nobody documents.
 *
 * These three fields are what a later process needs to decide the holder is gone: `pid` + `hostname`
 * because a pid is only meaningful on the machine that issued it, and `startedAt` because a pid can
 * be recycled and because a holder on another host can only ever be judged by age.
 */
interface LockOwner { pid: number; hostname: string; startedAt: string }
/**
 * How long a lock may be held before any other process may take it over. A hold is local file IO
 * only — remote delivery happens outside the lock — so a legitimate hold is milliseconds; a minute
 * is far past any plausible one while staying far short of "the operator gave up and rebooted".
 */
const LOCK_TTL_MS = 60_000;
function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  /* Best effort only, and deliberately not a signal handler: 'exit' does not run for SIGKILL or for
     an unhandled signal, so the reclaim path below stays the load-bearing recovery mechanism and
     this is just the cheap way to keep an orderly exit from leaving litter behind. */
  process.on('exit', () => {
    for (const lock of heldLocks) {
      try { rmSync(lock, { recursive: true, force: true }); } catch { /* the process is exiting anyway */ }
    }
  });
}
/** Whether a pid exists on this host. EPERM means it exists and belongs to somebody else. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
async function readLockOwner(lock: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(lock, LOCK_OWNER_FILE), 'utf8')) as Partial<LockOwner>;
    if (typeof parsed?.pid !== 'number' || typeof parsed.hostname !== 'string' || typeof parsed.startedAt !== 'string') return null;
    return { pid: parsed.pid, hostname: parsed.hostname, startedAt: parsed.startedAt };
  } catch { return null; }
}
/**
 * Why an existing lock may be taken over, or null when it must be waited on.
 *
 * Two independent signals, because neither alone covers the failure: a dead pid on this host is
 * proof the holder is gone and is available immediately, while age is the only thing that can be
 * said about a holder on another host, a recycled pid, or a lock written by a version of XForge
 * that recorded no owner at all.
 */
async function lockReclaimReason(lock: string, now: number): Promise<string | null> {
  const owner = await readLockOwner(lock);
  if (owner === null) {
    /* Either a pre-owner-file lock, or the sub-millisecond window between another process's mkdir
       and its owner write. Age is the only available signal, so it is the only one used — which
       also means a lock being created right now is never mistaken for an abandoned one. */
    const age = await stat(lock).then((info) => now - info.mtimeMs).catch(() => 0);
    return age > LOCK_TTL_MS ? 'no-owner-expired' : null;
  }
  if (owner.hostname === hostname() && !processAlive(owner.pid)) return `process-gone:${owner.pid}`;
  const startedAt = Date.parse(owner.startedAt);
  if (Number.isFinite(startedAt) && now - startedAt > LOCK_TTL_MS) return `expired:${owner.pid}`;
  return null;
}
interface HeldLock {
  release: () => Promise<void>;
  /** Set when this acquisition took a lock over from a holder that is provably gone. */
  reclaimed: { path: string; reason: string } | null;
}
export async function acquireLock(project: ProjectContext, shardKey: string | null): Promise<HeldLock> {
  const relative = `${LOCK_DIRECTORY}/${shardKey ?? GLOBAL_SHARD_KEY}.lock`;
  const lock = await safeResolve(project.root, relative);
  await mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let reclaimed: HeldLock['reclaimed'] = null;
  for (;;) {
    let acquired = false;
    try {
      await mkdir(lock);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (acquired) {
      heldLocks.add(lock);
      registerExitCleanup();
      const owner: LockOwner = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
      /* A failed owner write must not fail the append: the lock still excludes, it just degrades to
         age-based reclaim. */
      await writeFile(path.join(lock, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, 'utf8').catch(() => undefined);
      return {
        reclaimed,
        release: async () => { heldLocks.delete(lock); await rm(lock, { recursive: true, force: true }); },
      };
    }
    const reason = await lockReclaimReason(lock, Date.now());
    if (reason !== null) {
      /* Racy by construction, and harmlessly so: if two waiters both decide to reclaim, one wins the
         following mkdir and the other finds a fresh, live, un-reclaimable lock on its next pass. */
      await rm(lock, { recursive: true, force: true });
      reclaimed = { path: relative, reason };
      continue;
    }
    if (Date.now() >= deadline) {
      /* An XForgeError, not a bare Error: this used to surface as an unstructured crash with no
         diagnostic and no next action, on a condition whose remedy is a single named path. */
      throw new XForgeError(
        diagnostic(
          'XFORGE_AUDIT_LOCK_TIMEOUT',
          `Timed out after ${LOCK_TIMEOUT_MS / 1000}s waiting for the audit append lock ${relative}, which is held by a live process.`,
          relative,
        ),
        {
          nextActions: [{
            action: `Wait for the other xforge process to finish, or delete ${relative} if none is running`,
            reason: `The lock is held by a process that is still alive on this host. XForge reclaims a lock automatically once its owner exits or the lock is older than ${LOCK_TTL_MS / 1000}s, so deleting it by hand is only needed when neither has happened.`,
            type: 'maintenance',
            command: ['rm', '-rf', relative],
          }],
          root: project.root,
        },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}
