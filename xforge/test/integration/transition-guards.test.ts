import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readChangeAuditIndex } from '../../src/core/audit.js';
import { sha256, stableStringify } from '../../src/core/hash.js';
import { loadProject } from '../../src/core/project-loader.js';
import type { TransitionReceipt } from '../../src/types.js';
import { createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

const CHANGE = 'add-feature';
const transitionsRelative = `xforge/changes/${CHANGE}/evidence/receipts/transitions`;
const indexRelative = `xforge/changes/${CHANGE}/evidence/audit/index.json`;
const absolute = (root: string, relative: string): string => path.join(root, ...relative.split('/'));

async function structurePassed(root: string): Promise<void> {
  await createCompleteSolidChange(root);
  expect((await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure'])).code).toBe(0);
}

async function receipts(root: string): Promise<TransitionReceipt[]> {
  const directory = absolute(root, transitionsRelative);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const loaded = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8')) as TransitionReceipt));
  return loaded.sort((left, right) => left.sequence - right.sequence);
}

function codes(result: { json: any }): string[] {
  return (result.json?.diagnostics ?? []).map((item: any) => item.code);
}

/**
 * What a run killed between `atomicWrite`ing the receipt and recording `stage.entered` leaves on
 * disk: a structurally perfect receipt, correctly chained to its predecessor, that no audit event
 * attests. `auditHead` is inherited from the predecessor because a real crash remnant is written by
 * this working tree and therefore binds to a chain head this working tree still holds — the very
 * property that separates it from a colleague's receipt arriving through Git. `to` points back at
 * the previous Stage so the resolved current Stage stays real and the next transition is genuinely
 * available.
 */
function fabricateCrashReceipt(previous: TransitionReceipt): TransitionReceipt {
  const unsigned = {
    apiVersion: previous.apiVersion, kind: previous.kind, receiptId: randomUUID(),
    sequence: previous.sequence + 1, change: previous.change, flow: previous.flow,
    from: previous.to, to: previous.from,
    contentRevision: previous.contentRevision, stateRevisionBefore: previous.stateRevisionBefore,
    policySnapshotDigest: previous.policySnapshotDigest, gitHead: previous.gitHead,
    previousReceiptDigest: previous.digest, transitionedAt: new Date().toISOString(),
    actor: previous.actor, approvals: previous.approvals, gates: previous.gates, auditHead: previous.auditHead,
  };
  return { ...unsigned, digest: sha256(stableStringify(unsigned)) };
}

async function plantCrashReceipt(root: string): Promise<TransitionReceipt> {
  const previous = (await receipts(root)).at(-1)!;
  const orphan = fabricateCrashReceipt(previous);
  await write(root, `${transitionsRelative}/${String(orphan.sequence).padStart(4, '0')}-${orphan.receiptId}.json`, `${JSON.stringify(orphan, null, 2)}\n`);
  return orphan;
}

/**
 * A second machine: `xforge/.audit/**` is gitignored, so a clone carries the receipts but none of
 * the events that attest them. The committed index is the only surviving attestation, and here it is
 * gone — then rebuilt from the clone's own events by the first command that records anything, which
 * leaves a digest-valid, untruncated, unpruned index that simply does not know about the receipts.
 */
async function cloneWithoutAuditData(root: string): Promise<void> {
  await rm(absolute(root, 'xforge/.audit'), { recursive: true, force: true });
  await rm(absolute(root, indexRelative), { force: true });
}

describe('transition orphan-receipt scan', () => {
  it('warns without blocking when the last receipt has no attesting stage.entered event', async () => {
    const root = await fixture();
    await structurePassed(root);
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'design'])).code).toBe(0);
    const orphan = await plantCrashReceipt(root);

    const result = await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);
    const warning = (result.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_TRANSITION_ORPHAN_RECEIPT');
    expect(warning, JSON.stringify(result.json.diagnostics, null, 2)).toBeTruthy();
    expect(warning.severity).toBe('warning');
    expect(warning.message).toContain(orphan.receiptId);

    /* Warn, do not block: there is no `xforge audit repair`, so refusing here would leave deleting
       governance evidence as the only exit — the remedy this scan exists to avoid recommending. */
    expect(result.code).toBe(0);
    expect(result.json.data.receipt).toBeTruthy();
    expect((await receipts(root)).map((receipt) => receipt.receiptId)).toContain(orphan.receiptId);

    const action = result.json.nextActions.find((item: any) => item.action === 'reconcile-orphan-receipt');
    expect(action).toMatchObject({ type: 'governance', actor: 'human' });
    expect(action.reason).toContain('Do not delete the receipt');
    /* Half the point of the rewrite: deleting the receipt rewinds the Change's current Stage and
       breaks the previousReceiptDigest chain of every later receipt, so no nextAction may ask for
       it — least of all on a finding that could still be a false positive. */
    expect(action.command).toEqual(['xforge', 'audit', 'status', '--change', CHANGE]);
    for (const item of result.json.nextActions) expect(item.action).not.toBe('remove-orphan-receipt');
  });

  it('does not accuse receipts a clone inherited when the committed index no longer covers them', async () => {
    const root = await fixture();
    await structurePassed(root);
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'design'])).code).toBe(0);
    const inherited = (await receipts(root)).at(-1)!;
    await cloneWithoutAuditData(root);
    /* Anything that records an event for the Change refills the local chain and rewrites the index
       — `check` records gate.before/gate.after. From here a "was the chain pruned?" guard sees a
       healthy, unpruned local chain plus a usable index and concludes the receipt is a crash
       remnant, when it is only evidence that the attesting events live on another machine. */
    expect((await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure'])).code).toBe(0);

    const project = await loadProject(root, { exactRoot: true });
    const index = await readChangeAuditIndex(project, CHANGE);
    expect(index?.digestValid).toBe(true);
    expect(index?.document.eventsTruncated).toBe(false);
    expect(index?.document.chain.prunedCount).toBe(0);
    expect(index?.document.events.some((event) => event.eventType === 'stage.entered')).toBe(false);

    const result = await runCli(root, ['transition', '--change', CHANGE, '--to', 'check', '--dry-run']);
    expect(codes(result)).not.toContain('XFORGE_TRANSITION_ORPHAN_RECEIPT');
    expect(codes(result)).not.toContain('XFORGE_TRANSITION_RECEIPT_UNATTESTED');
    expect((await receipts(root)).map((receipt) => receipt.receiptId)).toContain(inherited.receiptId);
  });

  it('reports an unattested receipt followed by an attested one as missing audit data, not a crash', async () => {
    const root = await fixture();
    await structurePassed(root);
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'design'])).code).toBe(0);
    const orphan = await plantCrashReceipt(root);
    /* This transition records its own `stage.entered`, so the planted receipt is no longer the tail
       of the list: a crash cannot have produced a receipt that something later built on. */
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'design'])).code).toBe(0);

    const result = await runCli(root, ['transition', '--change', CHANGE, '--to', 'check', '--dry-run']);
    expect(codes(result)).not.toContain('XFORGE_TRANSITION_ORPHAN_RECEIPT');
    const note = (result.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_TRANSITION_RECEIPT_UNATTESTED');
    expect(note, JSON.stringify(result.json.diagnostics, null, 2)).toBeTruthy();
    expect(note.severity).toBe('info');
    expect(note.message).toContain(orphan.receiptId);
    expect(result.json.nextActions).toEqual([]);
  });

  it('says nothing about receipts on a clone that has no audit data at all', async () => {
    const root = await fixture();
    await structurePassed(root);
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'design'])).code).toBe(0);
    await cloneWithoutAuditData(root);

    const project = await loadProject(root, { exactRoot: true });
    expect(await readChangeAuditIndex(project, CHANGE)).toBeNull();

    const result = await runCli(root, ['transition', '--change', CHANGE, '--to', 'check', '--dry-run']);
    expect(codes(result)).not.toContain('XFORGE_TRANSITION_ORPHAN_RECEIPT');
    expect(codes(result)).not.toContain('XFORGE_TRANSITION_RECEIPT_UNATTESTED');
  });
});
