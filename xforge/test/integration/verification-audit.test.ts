import { describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readAuditEvents } from '../../src/core/audit.js';
import { sha256, stableStringify } from '../../src/core/hash.js';
import { loadProject } from '../../src/core/project-loader.js';
import type { AuditEvent } from '../../src/types.js';
import { fixture, runCli, updateYaml } from '../helpers.js';

/**
 * `verification declare` and `verification retire` decide how a Gate is run, and until now said so
 * to nobody but the Manifest.
 *
 * The two commands are the only governed writes in the product that changed a file and recorded no
 * event. That was arguably defensible — a Manifest edit moves `policySnapshotDigest`, which
 * invalidates approvals bound to the old one, so the change leaves *a* mark — but the mark says
 * "the Manifest moved", not "somebody decided this Gate should run this command". Those are
 * different facts and only one of them is a decision.
 *
 * The declarations here are about what the chain records, and what it deliberately does not: the
 * ambient actor rather than `--by`, and no `change`, because a declaration is not about one.
 */
async function eventsOn(root: string): Promise<AuditEvent[]> {
  return readAuditEvents(await loadProject(root));
}

const ofType = (events: AuditEvent[], type: string): AuditEvent[] => events.filter((event) => event.eventType === type);

describe('verification declaration audit', () => {
  it('records the declaration, bound to exactly what was written', async () => {
    const root = await fixture();
    const result = await runCli(root, [
      'verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["cargo","test"]', '--by', 'alex',
    ]);
    expect(result.code).toBe(0);

    const declared = ofType(await eventsOn(root), 'verification.declared');
    expect(declared).toHaveLength(1);
    expect(declared[0]!.decision).toBe('unit-tests');
    expect(declared[0]!.outcome).toBe('succeeded');

    /*
     * The event binds to the declaration rather than describing it. `input` is never persisted —
     * `recordAudit` keeps only its digest — so this is the assertion that the two cannot drift:
     * a declaration edited after the fact no longer hashes to the event that recorded it.
     */
    expect(declared[0]!.inputDigest).toBe(sha256(stableStringify({
      gate: 'unit-tests', entry: result.json.data.entry, by: 'alex',
    })));
  });

  it('names whoever ran the command as the actor, never --by', async () => {
    const root = await fixture();
    await runCli(root, [
      'verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["cargo","test"]', '--by', 'alex',
    ]);

    /*
     * The one assertion here that is about governance rather than bookkeeping.
     *
     * `--by` is a name the caller supplies, and the caller can be an Agent. Promoting it into
     * `actor` would let that Agent write its own authority into the audit chain — the single thing
     * the chain exists not to accept. The declarer is recorded where it can be read against the
     * Git identities the repository actually has: `declaredBy`, in the Manifest.
     */
    const declared = ofType(await eventsOn(root), 'verification.declared')[0]!;
    expect(declared.actor.id).not.toBe('alex');
    const manifest = await readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('declaredBy: alex');
  });

  it('leaves the declaration off any Change, because it is not about one', async () => {
    const root = await fixture();
    await runCli(root, [
      'verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["cargo","test"]', '--by', 'alex',
    ]);

    /* A declaration applies to every Change that runs this Gate afterwards, so it belongs to the
       project rather than to whichever Change happened to be open when it was made. */
    expect(ofType(await eventsOn(root), 'verification.declared')[0]!.change).toBeNull();
  });

  it('records the withdrawal, with the reason given for it', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.verification = {
        'unit-tests': [
          { command: ['node', '-e', 'process.exit(0)'], declaredBy: 'owner@example.test', declaredAt: '2026-01-01T00:00:00Z' },
          { command: ['node', '-e', 'console.log("docs")'], declaredBy: 'owner@example.test', declaredAt: '2026-01-02T00:00:00Z' },
        ],
      };
    });
    const result = await runCli(root, [
      'verification', 'retire', '--gate-name', 'unit-tests',
      '--command', '["node","-e","console.log(\\"docs\\")"]',
      '--by', 'owner@example.test', '--reason', 'The phase that needed the documentation grep is over.',
    ]);
    expect(result.code).toBe(0);

    const retired = ofType(await eventsOn(root), 'verification.retired');
    expect(retired).toHaveLength(1);
    expect(retired[0]!.decision).toBe('unit-tests');
    expect(retired[0]!.reason).toBe('The phase that needed the documentation grep is over.');
  });

  it('records nothing under --dry-run', async () => {
    const root = await fixture();
    const planned = await runCli(root, [
      'verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["cargo","test"]', '--by', 'alex', '--dry-run',
    ]);
    expect(planned.code).toBe(0);
    /* The plan still reports the write it would make; what must not happen is the record of one. */
    expect(planned.json.changes).toHaveLength(1);
    expect(ofType(await eventsOn(root), 'verification.declared')).toHaveLength(0);
  });

  it('puts the Manifest back when the declaration cannot be recorded', async () => {
    const root = await fixture();
    const before = await readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8');

    /*
     * `.audit` as a file rather than a directory, so appending to the chain fails for a reason that
     * has nothing to do with what is being recorded.
     *
     * Why this case earns a test of its own: `declare` appends. `verification[gate]` becomes
     * `[...existing, entry]` with a fresh `declaredAt`, so a retry after a half-recorded write
     * would leave two near-identical declarations of the same command rather than redoing one —
     * and the Gate runs every declaration it finds, in order.
     */
    const auditPath = path.join(root, 'xforge', '.audit');
    await rm(auditPath, { recursive: true, force: true });
    await writeFile(auditPath, 'not a directory\n');

    const result = await runCli(root, [
      'verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["cargo","test"]', '--by', 'alex',
    ]);
    expect(result.code).toBe(1);
    expect(await readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8')).toBe(before);

    /* And the route out is a plain retry: with the chain writable again, one declaration lands. */
    await rm(auditPath, { force: true });
    await mkdir(auditPath, { recursive: true });
    const retried = await runCli(root, [
      'verification', 'declare', '--gate-name', 'unit-tests',
      '--command', '["cargo","test"]', '--by', 'alex',
    ]);
    expect(retried.code).toBe(0);
    /* One `cargo` declaration and not two, which is the whole point of putting the Manifest back:
       the retry is a redo rather than a second append. Counted in the file rather than from
       `declarations`, which also counts whatever the fixture already declared for this Gate. */
    const after = await readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8');
    expect(after.split('\n').filter((line) => line.includes('cargo')).length).toBe(1);
  });
});
