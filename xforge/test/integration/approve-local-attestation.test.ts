import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli, runCliWithStdin, updateYaml, write } from '../helpers.js';
import { executeApprove, type ApprovalTerminal } from '../../src/commands/approve.js';
import { loadProject } from '../../src/core/project-loader.js';

async function toDesign(root: string): Promise<void> {
  await createCompleteSolidChange(root);
  expect((await runCli(root, ['install'])).code).toBe(0);
  expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
  expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
}

/** Every field an Agent could possibly pass on the command line. */
const localApproveArgs = [
  'approve', '--change', 'add-feature', '--for', 'check', '--policy', 'planning-solid',
  '--actor', 'owner@example.test', '--role', 'owner', '--reason', 'Looks good.', '--decision', 'approve', '--attestation', 'human',
];

async function recordedApprovals(root: string): Promise<string[]> {
  const directory = path.join(root, 'xforge', 'changes', 'add-feature', 'approvals', 'planning-solid');
  try { await access(directory); } catch { return []; }
  return readdir(directory);
}

/** A scripted stand-in for the human at the terminal. There is nothing to read back: XForge no
 * longer has a confirmation code, so the script only ever answers the identity/role/decision/reason
 * questions. */
function scriptedTerminal(answers: Record<string, string>): ApprovalTerminal & { asked: string[] } {
  const terminal = {
    asked: [] as string[],
    present() {},
    async question(prompt: string) {
      terminal.asked.push(prompt);
      for (const [key, answer] of Object.entries(answers)) {
        if (prompt.includes(key)) return answer;
      }
      return '';
    },
  };
  return terminal;
}

describe('local approval human attestation', () => {
  it('refuses an Agent-style invocation that supplies every flag, including --attestation human', async () => {
    const root = await fixture();
    await toDesign(root);
    const result = await runCli(root, localApproveArgs);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.some((item: any) => item.code === 'XFORGE_APPROVAL_INTERACTIVE_REQUIRED')).toBe(true);
    expect(await recordedApprovals(root)).toEqual([]);
  });

  /*
   * The one that matters. `approvals.local.requireTty: false` used to let a caller pipe the four
   * answers into a non-terminal stdin and get back a receipt that is genuinely produced by
   * `approve`: a real matching approval.decided chain event, attestation.method 'cli-terminal' set
   * by the CLI itself, nothing on it distinguishable from a decision a person made. That switch
   * lived in manifest.yaml — inside the tree the governed Agent writes — which made it the Agent's
   * own decision whether the check applied to it. The setting is gone, so a piped decision is
   * refused however the manifest is configured.
   *
   * This does not claim a TTY proves a human: a pty answering these same prompts still succeeds
   * (see the comment above `interactive` in cli.ts). It pins that the one governance-relaxing knob
   * the Agent could reach for no longer exists.
   */
  it('refuses a decision piped into a non-terminal stdin', async () => {
    const root = await fixture();
    await toDesign(root);
    const result = await runCliWithStdin(root, localApproveArgs, 'alice\nowner\napprove\nLGTM\n');
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_APPROVAL_INTERACTIVE_REQUIRED');
    expect(await recordedApprovals(root)).toEqual([]);
  });

  /* And the manifest can no longer even express the request: `approvals.local` is not a key. */
  it('rejects a manifest that still tries to configure the local approval path', async () => {
    const root = await fixture();
    await toDesign(root);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.approvals.local = { requireTty: false };
    });
    const state = await runCli(root, ['state']);
    expect(state.code).toBe(1);
    expect(state.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_SCHEMA_INVALID');
    const result = await runCliWithStdin(root, localApproveArgs, 'alice\nowner\napprove\nLGTM\n');
    expect(result.code).toBe(1);
    expect(await recordedApprovals(root)).toEqual([]);
  });

  /*
   * There is no `--receipt` import path anymore: a receipt is only ever trusted if the project's own
   * audit hash chain independently recorded the `approval.decided` event that produced it. A receipt
   * file placed directly on disk — bypassing `xforge approve` entirely — has no such event, however
   * well-formed it looks, and must never be counted as a valid approval.
   */
  it('never counts a hand-placed receipt with no matching audit chain event as a valid approval', async () => {
    const root = await fixture();
    await toDesign(root);
    const state = await runCli(root, ['state', '--change', 'add-feature']);
    const governance = state.json.data.change.governance;
    const { sha256, stableStringify } = await import('../../src/core/hash.js');
    const { randomUUID } = await import('node:crypto');
    const payload = {
      apiVersion: 'xforge.dev/v1alpha2', kind: 'ApprovalReceipt', receiptId: randomUUID(), change: 'add-feature',
      flow: 'solid', stage: 'design', transition: 'check', policyId: 'planning-solid',
      stateRevision: governance.revision.stateRevision, contentRevision: governance.revision.contentRevision,
      policySnapshotDigest: governance.revision.policySnapshotDigest, gitBase: governance.revision.gitBase, gitHead: governance.revision.gitHead,
      governingRevision: governance.revision.governingRevision,
      governingDigest: sha256(stableStringify({ change: 'add-feature', flow: 'solid', policy: 'planning-solid', revision: governance.revision })),
      decision: 'approve', approver: { id: 'agent@example.test', provider: 'local', role: 'owner', type: 'human' },
      decidedAt: new Date().toISOString(), reason: 'Self-issued.',
    };
    const receipt = { ...payload, digest: sha256(stableStringify(payload)) };
    await write(root, 'xforge/changes/add-feature/approvals/planning-solid/forged.json', `${JSON.stringify(receipt, null, 2)}\n`);
    const after = await runCli(root, ['state', '--change', 'add-feature']);
    expect(after.json.diagnostics.some((item: any) => item.code === 'XFORGE_APPROVAL_NOT_IN_AUDIT_CHAIN')).toBe(true);
    expect(after.json.data.change.governance.readyTransitions.find((item: any) => item.to === 'check').ready).toBe(false);
    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'check'])).code).toBe(1);
  });

  it('records an approval when the human types the decision at the terminal', async () => {
    const root = await fixture();
    await toDesign(root);
    const project = await loadProject(root, { exactRoot: true });
    const terminal = scriptedTerminal({
      'Approver identity': 'owner@example.test',
      'Approver role': 'owner',
      'Decision': 'approve',
      'Reason': 'Reviewed the design at the terminal.',
    });
    const result = await executeApprove(project, {
      change: 'add-feature', transition: 'check', policy: 'planning-solid', interactive: true, dryRun: false, terminal,
    });
    expect(result.data.receipt).not.toBeNull();
    expect(result.data.receipt!.approver).toEqual({ id: 'owner@example.test', provider: 'local', role: 'owner', type: 'human' });
    expect(result.data.receipt!.attestation).toMatchObject({ method: 'cli-terminal', respondedAt: expect.any(String) });
    expect((result.data.receipt as any).signature).toBeUndefined();
    /* P2-3: a local receipt is bounded in time instead of never expiring. */
    expect(Date.parse(result.data.receipt!.expiresAt!)).toBeGreaterThan(Date.now());
    expect(await recordedApprovals(root)).toHaveLength(1);
    /* The receipt is trusted here because this same run also wrote a matching approval.decided
       event to the audit chain — not because of anything typed back. */
    const state = await runCli(root, ['state', '--change', 'add-feature']);
    expect(state.json.diagnostics.some((item: any) => item.code === 'XFORGE_APPROVAL_NOT_IN_AUDIT_CHAIN')).toBe(false);
    expect(state.json.data.change.governance.readyTransitions.find((item: any) => item.to === 'check').ready).toBe(true);
  });

  it('refuses when the decision is not typed at the terminal, even if flags suggest one', async () => {
    const root = await fixture();
    await toDesign(root);
    const project = await loadProject(root, { exactRoot: true });
    /* Flags may suggest identity and reason, but never the decision itself. */
    await expect(executeApprove(project, {
      change: 'add-feature', transition: 'check', policy: 'planning-solid', interactive: true, dryRun: false,
      actor: 'owner@example.test', role: 'owner', reason: 'Looks good.', decision: 'approve', attestation: 'human',
      terminal: scriptedTerminal({ 'Approver identity': 'owner@example.test', 'Approver role': 'owner', 'Reason': 'Looks good.' }),
    })).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'XFORGE_APPROVAL_DECISION_REQUIRED' })] });
    expect(await recordedApprovals(root)).toEqual([]);
  });
});
