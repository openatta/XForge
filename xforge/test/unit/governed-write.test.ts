/*
 * @red-first coverage-only: it proves no fix. The conflict path turned out to be correct — these four cases pass against the parent commit too. What was missing was any execution of it at all: coverage had `write/governed.ts` at 50% of functions with the `EEXIST` branch and the conflict constructor untouched, so the half of the primitive that keeps two different failures apart was the half nothing had ever run.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GovernedWriteConflict, governedWrite } from '../../src/write/governed.js';
import type { ProjectContext } from '../../src/types.js';

/**
 * The two failure paths of a governed write, neither of which anything had ever executed.
 *
 * Coverage put `write/governed.ts` at 50% of functions with lines 69-71 and 103-105 untouched:
 * the `GovernedWriteConflict` constructor and the `EEXIST` that raises it. That is the half of the
 * primitive that exists to keep two different failures apart, and it was the untested half —
 * `XFORGE_TRANSITION_RECEIPT_EXISTS`, the diagnostic it feeds, has sat on the suite's own
 * `untested-codes.txt` debt list since before this primitive existed.
 *
 * The second test is the one worth having. Folding transition's two try blocks into one call made
 * every `EEXIST` from inside `record` look like a receipt collision — and the audit chain takes its
 * lock with `mkdir`, which fails with exactly that code. A lock contention reported as "a receipt
 * for this sequence already exists" sends a reader to look for a receipt that is not there.
 */

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(): Promise<ProjectContext> {
  const root = await mkdtemp(path.join(tmpdir(), 'xforge-governed-'));
  roots.push(root);
  await mkdir(path.join(root, 'records'), { recursive: true });
  return { root } as unknown as ProjectContext;
}

const RECORD = 'records/receipt.json';

describe('governed write', () => {
  it('refuses to replace a record that is already there, and leaves it alone', async () => {
    const context = await project();
    await writeFile(path.join(context.root, RECORD), 'first\n');
    let recorded = false;

    await expect(governedWrite(context, {
      path: RECORD, content: 'second\n', mode: 'exclusive', record: async () => { recorded = true; },
    })).rejects.toBeInstanceOf(GovernedWriteConflict);

    expect(await readFile(path.join(context.root, RECORD), 'utf8')).toBe('first\n');
    /* Nothing landed, so nothing is recorded: a write that never happened must not be attested. */
    expect(recorded).toBe(false);
  });

  it('does not mistake an EEXIST from the recording for a collision on the record', async () => {
    /*
     * The distinction the conflict type exists for. `recordAudit` acquires its lock with `mkdir`,
     * so this is the shape of a real lock contention — and it must reach the caller as itself, not
     * as "that record already exists".
     */
    const context = await project();
    const contention = Object.assign(new Error('lock held'), { code: 'EEXIST' });

    await expect(governedWrite(context, {
      path: RECORD, content: 'attempt\n', mode: 'exclusive', record: async () => { throw contention; },
    })).rejects.toBe(contention);

    /* And the write is unwound, because the record is worthless without its event. */
    await expect(readFile(path.join(context.root, RECORD), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('puts back the previous bytes rather than deleting somebody else\'s attested record', async () => {
    /* The supersede case: `work-package acknowledge` overwrites an earlier receipt that is
       committed and attested, and answering a failed recording by destroying it would turn a
       retryable error into lost evidence. */
    const context = await project();
    await writeFile(path.join(context.root, RECORD), 'earlier\n');

    await expect(governedWrite(context, {
      path: RECORD, content: 'later\n', record: async () => { throw new Error('audit unavailable'); },
    })).rejects.toThrow('audit unavailable');

    expect(await readFile(path.join(context.root, RECORD), 'utf8')).toBe('earlier\n');
  });

  it('keeps the record when the recording succeeds', async () => {
    const context = await project();
    await governedWrite(context, { path: RECORD, content: 'kept\n', mode: 'exclusive', record: async () => undefined });
    expect(await readFile(path.join(context.root, RECORD), 'utf8')).toBe('kept\n');
  });
});
