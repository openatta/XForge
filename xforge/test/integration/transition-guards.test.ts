import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readChangeAuditIndex } from '../../src/core/audit.js';
import { sha256, stableStringify } from '../../src/core/hash.js';
import { loadProject } from '../../src/core/project-loader.js';
import { executeTransition, repairTransitionChain } from '../../src/commands/transition.js';
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

/**
 * A receipt claiming the same place in the chain as `sibling`, differing only in where it goes.
 *
 * This is what a `git merge` hands you, with no conflict to resolve: two developers branch from the
 * same commit, each records a Stage transition out of the same Stage, and each receipt used to be
 * named with a fresh UUID — so Git saw two *added* files in one directory and kept both.
 */
function fabricateSibling(sibling: TransitionReceipt, to: string): TransitionReceipt {
  const { digest: _digest, ...unsigned } = { ...sibling, receiptId: randomUUID(), to, transitionedAt: new Date().toISOString() };
  return { ...unsigned, digest: sha256(stableStringify(unsigned)) };
}

/** A receipt that jumps to a Stage the Flow cannot reach from `from`, with an otherwise perfect chain. */
function fabricateSkip(previous: TransitionReceipt, to: string): TransitionReceipt {
  const { digest: _digest, ...unsigned } = {
    ...previous, receiptId: randomUUID(), sequence: previous.sequence + 1,
    from: previous.to, to, previousReceiptDigest: previous.digest, transitionedAt: new Date().toISOString(),
  };
  return { ...unsigned, digest: sha256(stableStringify(unsigned)) };
}

async function plant(root: string, receipt: TransitionReceipt): Promise<TransitionReceipt> {
  await write(root, `${transitionsRelative}/${String(receipt.sequence).padStart(4, '0')}-${receipt.receiptId}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

async function blockedFor(root: string, to: string): Promise<string[]> {
  const state = await runCli(root, ['state', '--change', CHANGE]);
  return (state.json.data.change.governance.readyTransitions as any[]).find((item) => item.to === to)?.blockedBy ?? [];
}

describe('transition chain forks', () => {
  /*
   * The defect this pins needs no concurrency at all: two branches, two receipts at the same
   * sequence, one clean merge. Before the fix that made every command on the Change fail with an
   * error diagnostic, with no repair path and standing guidance not to delete the receipt.
   */
  it('names a duplicate sequence, blocks only transitions, and repairs by dropping the leaf', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure'])).code).toBe(0);
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'design'])).code).toBe(0);
    const opening = (await receipts(root)).at(-1)!;

    /* Branch A took Design forward to Check; branch B sent it back to Propose for rework. Both are
       legal transitions out of Design, both are sequence 2, and neither knows about the other. */
    const forward = await plant(root, fabricateSibling({ ...opening, sequence: 2, from: 'design', previousReceiptDigest: opening.digest }, 'check'));
    const rework = await plant(root, fabricateSibling({ ...opening, sequence: 2, from: 'design', previousReceiptDigest: opening.digest }, 'propose'));

    const state = await runCli(root, ['state', '--change', CHANGE]);
    /* The Change must still be readable. An error here is what bricked it: `control.diagnostics` is
       spread into the blocking set of transition, work-package, archive and state alike. */
    expect(state.code, JSON.stringify(state.json?.diagnostics)).toBe(0);
    const fork = (state.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_TRANSITION_CHAIN_INVALID');
    expect(fork, JSON.stringify(state.json.diagnostics)).toBeTruthy();
    expect(fork.severity).toBe('warning');
    expect(fork.message).toContain('sequence 2');
    expect(fork.details.droppable).toEqual(expect.arrayContaining([forward.receiptId, rework.receiptId]));

    /* Blocked, but only where a forked history actually makes the answer unknowable. */
    for (const target of (state.json.data.change.governance.readyTransitions as any[])) {
      expect(target.blockedBy).toContain('transition-chain:invalid');
    }
    /* `design` is a legal target from both sides of the fork, so the refusal is about the fork. */
    const refused = await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);
    expect(refused.code).toBe(1);
    expect((refused.json.diagnostics as any[]).some((item) => item.message.includes('transition-chain:invalid'))).toBe(true);

    /* The repair drops the branch nothing was built on and the Change comes back to life. */
    const project = await loadProject(root, { exactRoot: true });
    const repaired = await repairTransitionChain(project, { change: CHANGE, receiptId: rework.receiptId, dryRun: false });
    expect(repaired.data.dropped?.receiptId).toBe(rework.receiptId);
    /* Dropping a fork's leaf leaves the surviving branch contiguous, so nothing is rewritten and no
       already-recorded stage.entered attestation is invalidated. */
    expect(repaired.data.renumbered).toEqual([]);

    const after = await runCli(root, ['state', '--change', CHANGE]);
    expect(codes(after)).not.toContain('XFORGE_TRANSITION_CHAIN_INVALID');
    expect(after.json.data.change.governance.currentStage).toBe('check');
    expect((await receipts(root)).map((item) => item.receiptId)).not.toContain(rework.receiptId);
    expect(await blockedFor(root, 'apply')).not.toContain('transition-chain:invalid');
  });

  it('refuses to drop a receipt a later receipt chains to', async () => {
    const root = await fixture();
    await structurePassed(root);
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'design'])).code).toBe(0);
    const opening = (await receipts(root)).at(-1)!;
    const project = await loadProject(root, { exactRoot: true });
    await plant(root, fabricateSibling({ ...opening, sequence: 2, from: 'design', previousReceiptDigest: opening.digest }, 'check'));

    await expect(repairTransitionChain(project, { change: CHANGE, receiptId: opening.receiptId, dryRun: false }))
      .rejects.toThrow(/chains to its digest/);
    expect((await receipts(root)).map((item) => item.receiptId)).toContain(opening.receiptId);
  });

  /* The receipt name is the whole reason the merge above was silent: a UUID in it meant two writers
     never collided on one path, so Git had nothing to ask about. */
  it('names a receipt after its sequence alone, so a second writer collides instead of forking', async () => {
    const root = await fixture();
    await structurePassed(root);
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'design'])).code).toBe(0);
    const names = (await readdir(absolute(root, transitionsRelative))).filter((name) => name.endsWith('.json'));
    expect(names).toEqual(['0001.json']);

    /* Two transitions in flight at once must not produce two receipts at one sequence, however the
       two runs happen to interleave. */
    const project = await loadProject(root, { exactRoot: true });
    await Promise.allSettled([
      executeTransition(project, { change: CHANGE, to: 'propose', dryRun: false }),
      executeTransition(project, { change: CHANGE, to: 'propose', dryRun: false }),
    ]);
    const sequences = (await receipts(root)).map((item) => item.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

describe('transition receipt reachability', () => {
  /*
   * The continuity check validated sequence, previousReceiptDigest and `from`, and took `to` on the
   * receipt's word — while the schema leaves both as free strings. So one hand-written file skipped
   * Check, Apply and Verify, and `terminalGovernanceBlocks` then re-checked the Gates of the Stage
   * the skip was designed to leave behind.
   */
  it('rejects a receipt whose target Stage the Flow cannot reach from its source', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure'])).code).toBe(0);
    expect((await runCli(root, ['transition', '--change', CHANGE, '--to', 'design'])).code).toBe(0);
    const skip = await plant(root, fabricateSkip((await receipts(root)).at(-1)!, 'ready-to-archive'));

    const state = await runCli(root, ['state', '--change', CHANGE]);
    const rejected = (state.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_TRANSITION_UNREACHABLE_STAGE');
    expect(rejected, JSON.stringify(state.json.diagnostics)).toBeTruthy();
    expect(rejected.severity).toBe('error');
    /* The message has to say what was claimed and what is legal, or it cannot be acted on. */
    expect(rejected.message).toContain('design -> ready-to-archive');
    expect(rejected.message).toContain('check');
    expect(rejected.details.receiptId).toBe(skip.receiptId);

    /* A receipt that is not evidence of a legitimate transition must not close the Change either. */
    const archived = await runCli(root, ['archive', '--change', CHANGE]);
    expect(archived.code).toBe(1);
    expect(codes(archived)).toContain('XFORGE_TRANSITION_UNREACHABLE_STAGE');
  });
});

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
