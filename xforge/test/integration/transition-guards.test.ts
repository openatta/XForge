import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneExpiredAuditEvents, recordAudit } from '../../src/core/audit.js';
import { sha256, stableStringify } from '../../src/core/hash.js';
import { loadProject } from '../../src/core/project-loader.js';
import { createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

const transitionsRelative = 'xforge/changes/add-feature/evidence/receipts/transitions';
const transitionsDir = (root: string): string => path.join(root, ...transitionsRelative.split('/'));

async function structurePassed(root: string): Promise<void> {
  await createCompleteSolidChange(root);
  expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
}

async function firstReceipt(root: string): Promise<any> {
  const names = (await readdir(transitionsDir(root))).filter((name) => name.endsWith('.json'));
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(path.join(transitionsDir(root), names[0]!), 'utf8'));
}

/**
 * A crash remnant: what a run killed between the receipt write and the `stage.entered` audit
 * record would leave behind. `to` points back at the previous Stage so the resolved current
 * Stage stays real, keeping the requested transition genuinely ready.
 */
function fabricateCrashReceipt(previous: any): any {
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

describe('transition audit-chain guards', () => {
  it('refuses to record a Transition when the audit chain does not verify', async () => {
    const root = await fixture();
    await structurePassed(root);
    /*
     * Corrupt the global (cross-Change) chain. Change-scoped facts — what the control plane
     * readiness check reads — still verify, so the Transition survives to the transition-level
     * verifyAudit guard, which must refuse it.
     */
    const log = path.join(root, 'xforge', '.audit', 'events.jsonl');
    await writeFile(log, '{"eventId":"bogus","eventType":"tampered"}\n');

    const result = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_TRANSITION_AUDIT_CHAIN_INVALID');
    expect(result.json.nextActions[0]).toMatchObject({ action: 'restore-audit-chain', command: ['xforge', 'audit', 'verify'] });
  });

  it('refuses to build on a Transition receipt the audit chain never attested', async () => {
    const root = await fixture();
    await structurePassed(root);
    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
    const orphan = fabricateCrashReceipt(await firstReceipt(root));
    await write(root, `${transitionsRelative}/0002-crash-remnant.json`, `${JSON.stringify(orphan, null, 2)}\n`);

    const result = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_TRANSITION_ORPHAN_RECEIPT');
    expect(result.json.diagnostics[0].message).toContain(orphan.receiptId);
    expect(result.json.nextActions[0]).toMatchObject({ action: 'remove-orphan-receipt' });
  });

  it('does not accuse receipts when a retention-pruned local chain has no usable committed index', async () => {
    const root = await fixture();
    await structurePassed(root);
    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
    const orphan = fabricateCrashReceipt(await firstReceipt(root));
    await write(root, `${transitionsRelative}/0002-crash-remnant.json`, `${JSON.stringify(orphan, null, 2)}\n`);

    /* Retention prunes every local event, leaving only the shard anchor. A fresh event keeps the
       local chain non-empty (so the scan would run), and the committed index — the survivor of the
       pruned attestations — is gone (a tampered one would be refused earlier as an invalid chain).
       The stage.entered attestations for the receipts now exist nowhere this machine can read: the
       scan cannot distinguish a crash remnant from a pruned-but-legitimate receipt, and must skip
       instead of accusing. */
    const project = await loadProject(root, { exactRoot: true });
    const pruned = await pruneExpiredAuditEvents(project, { retentionDays: 1, now: Date.now() + 5 * 86_400_000 });
    expect(pruned.removed).toBeGreaterThan(0);
    await recordAudit(project, { eventType: 'gate.after', change: 'add-feature', flow: 'solid', stage: 'propose', outcome: 'succeeded', deliver: false });
    await rm(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'audit', 'index.json'));

    const result = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    expect(result.json.diagnostics.map((item: any) => item.code)).not.toContain('XFORGE_TRANSITION_ORPHAN_RECEIPT');
  });
});
