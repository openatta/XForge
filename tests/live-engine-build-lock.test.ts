import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { produceOnce } from './live-engine/cli-source.mjs';

/**
 * `--cli-source local` builds the repository, and `npm run build`'s clean step deletes
 * `xforge/dist` and `scaffold/payload`. That is the one step of a live run that touches the shared
 * working tree rather than the scenario's isolated project, so it is the one step that cannot be
 * allowed to run twice at once.
 *
 * A content-keyed tarball cache was supposed to make scenarios parallelizable, and did — but only
 * from a *warm* start. Read-then-build is check-then-act, and on a cold start every scenario misses:
 * six launched together all ran the build and deleted each other's tree mid-copy. Three died on
 * ENOTEMPTY/ENOENT before a single model call, which on a live run is paid time and paid tokens.
 *
 * These tests drive the lock with a counter instead of a build. The property is exactly-once under
 * concurrency; whether the thing produced is a tarball is beside the point.
 */
describe('the live-engine build lock', () => {
  let root: string;
  let target: string;
  let lock: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'xforge-build-lock-'));
    target = path.join(root, 'artifact.tgz');
    lock = `${target}.lock`;
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  /** Slow enough that every other caller is guaranteed to find the lock held. */
  const slowProduce = (calls: string[]) => async () => {
    calls.push('produced');
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    await writeFile(target, 'artifact');
  };

  it('runs the work once when many callers race for it from cold', async () => {
    const calls: string[] = [];
    await Promise.all(Array.from({ length: 6 }, () => produceOnce({
      target, lock, produce: slowProduce(calls), pollMs: 20,
    })));

    expect(calls).toHaveLength(1);
    /* Every caller must still see the artifact — a waiter that returns before the producer has
       renamed it would install a tarball that is not there, which is the failure being prevented. */
    expect(await readdir(root)).toEqual(['artifact.tgz']);
  });

  it('does no work at all when the artifact already exists', async () => {
    await writeFile(target, 'artifact');
    const calls: string[] = [];
    await produceOnce({ target, lock, produce: slowProduce(calls), pollMs: 20 });
    expect(calls).toEqual([]);
  });

  it('releases the lock when the work throws, instead of wedging every later run', async () => {
    await expect(produceOnce({
      target, lock, pollMs: 20, produce: async () => { throw new Error('build failed'); },
    })).rejects.toThrow('build failed');

    /* A lock left behind by a failed build would make the next run wait out the full timeout for a
       process that is not coming back. The failure has to stay the failure it was. */
    expect(await readdir(root)).toEqual([]);
  });

  it('breaks a lock whose holder is gone, rather than waiting out the timeout', async () => {
    await mkdir(lock);
    /* pid 1 is init and always alive, so a pid that cannot be alive is needed. A pid recorded by a
       process that has since exited is precisely the state a Ctrl-C or a pkill leaves behind. */
    await writeFile(path.join(lock, 'pid'), `${2 ** 30}\n`);

    const calls: string[] = [];
    await produceOnce({ target, lock, produce: slowProduce(calls), pollMs: 20, timeoutMs: 3000 });
    expect(calls).toHaveLength(1);
  });

  it('waits for a live holder rather than breaking its lock', async () => {
    await mkdir(lock);
    /* This process is alive by definition, so the lock must be honoured. Without the pid check a
       stale-lock heuristic based on age alone would break a build that is simply slow. */
    await writeFile(path.join(lock, 'pid'), `${process.pid}\n`);

    await expect(produceOnce({
      target, lock, pollMs: 20, timeoutMs: 300, produce: async () => { throw new Error('must not run'); },
    })).rejects.toThrow(/Timed out waiting/);
  });

  it('treats a lock with no pid yet as held, not as stale', async () => {
    /* There is a window between `mkdir` succeeding and the pid being written. Reading that as an
       abandoned lock would let a second caller break a lock the holder is about to use — turning
       the fix back into the race it closes. */
    await mkdir(lock);

    await expect(produceOnce({
      target, lock, pollMs: 20, timeoutMs: 300, produce: async () => { throw new Error('must not run'); },
    })).rejects.toThrow(/Timed out waiting/);
  });
});
