import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveCurrentRevision, approvalTestEnv, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';
import { approvalsForPolicy } from '../../src/core/control-plane.js';

/** Runs the CLI with the harness approval secret and fails loudly, so setup steps cannot pass silently. */
async function successfulCli(root: string, args: string[]): Promise<any> {
  const result = await runCli(root, args, approvalTestEnv);
  if (result.code !== 0) throw new Error(`${args.join(' ')} failed: ${JSON.stringify(result.json?.diagnostics ?? result.stderr)}`);
  return result.json;
}

async function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(stdout).toString().trim()) : reject(new Error(`git ${args.join(' ')} failed with ${code}`)));
  });
}

async function initRepository(root: string, email = 'worker@example.test', name = 'Worker One'): Promise<void> {
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.email', email]);
  await git(root, ['config', 'user.name', name]);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'base']);
}

const majorPolicy = { id: 'implementation-major', minApprovers: 2, roles: ['owner', 'maintainer', 'security'], separationOfDuties: true, providers: ['enterprise-approvals'] };
const binding = { governingRevision: 'g1', stateRevision: 's1' };
const receipt = (id: string, role: string) => ({
  policyId: 'implementation-major', transition: 'apply', governingRevision: 'g1', stateRevision: 's1', decision: 'approve',
  approver: { id, provider: 'enterprise-approvals', role },
}) as any;

describe('Protocol 2 control plane', () => {
  /*
   * The previous rule required `distinct roles >= minApprovers`, which both rejected the most common
   * two-person review (two maintainers) and allowed the person who wrote the code to approve it.
   * Separation of duties now means: the approver is not one of the Change's implementers.
   */
  it('separates duties by implementer identity, not by role diversity', () => {
    const twoMaintainers = approvalsForPolicy([receipt('alice', 'maintainer'), receipt('bob', 'maintainer')], majorPolicy, 'apply', binding);
    expect(twoMaintainers.missing).toBe(0);
    expect(twoMaintainers.separationSatisfied).toBe(true);

    const selfApproved = approvalsForPolicy(
      [receipt('alice', 'maintainer'), receipt('bob', 'maintainer')],
      majorPolicy, 'apply', { ...binding, implementers: new Set(['bob']) },
    );
    expect(selfApproved.separationSatisfied).toBe(false);
    expect(selfApproved.selfApprovers).toEqual(['bob']);
    expect(selfApproved.missing).toBe(1);

    /* A policy without separationOfDuties never consults the implementer set. */
    const relaxed = approvalsForPolicy(
      [receipt('alice', 'maintainer'), receipt('bob', 'maintainer')],
      { ...majorPolicy, separationOfDuties: false }, 'apply', { ...binding, implementers: new Set(['bob']) },
    );
    expect(relaxed.separationSatisfied).toBe(true);
    expect(relaxed.missing).toBe(0);
  });

  it('matches legacy receipts on stateRevision and current receipts on governingRevision', () => {
    const policy = { ...majorPolicy, minApprovers: 1, separationOfDuties: false };
    const legacy = { ...receipt('alice', 'owner'), governingRevision: undefined, stateRevision: 's1' };
    expect(approvalsForPolicy([legacy], policy, 'apply', binding).missing).toBe(0);
    expect(approvalsForPolicy([legacy], policy, 'apply', { ...binding, stateRevision: 'moved' }).missing).toBe(1);
    /* A current receipt survives a state change it does not govern. */
    expect(approvalsForPolicy([receipt('alice', 'owner')], policy, 'apply', { ...binding, stateRevision: 'moved' }).missing).toBe(0);
    expect(approvalsForPolicy([receipt('alice', 'owner')], policy, 'apply', { ...binding, governingRevision: 'g2' }).missing).toBe(1);
  });

  it('ignores an expired local receipt', () => {
    const policy = { ...majorPolicy, minApprovers: 1, separationOfDuties: false, providers: ['local'] };
    const expired = { ...receipt('alice', 'owner'), approver: { id: 'alice', provider: 'local', role: 'owner' }, expiresAt: new Date(Date.now() - 1_000).toISOString() };
    expect(approvalsForPolicy([expired], policy, 'apply', binding).missing).toBe(1);
  });

  it('requires Machine Gate and a current signed Approval for transitions', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['install'])).code).toBe(0);
    const blocked = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design', '--dry-run']);
    expect(blocked.code).toBe(1);
    expect(blocked.json.diagnostics.some((item: any) => item.message.includes('gate:structure'))).toBe(true);

    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
    const approvalBlocked = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'check', '--dry-run']);
    expect(approvalBlocked.json.diagnostics.some((item: any) => item.message.includes('approval:planning-solid'))).toBe(true);

    await approveCurrentRevision(root, 'add-feature', 'check', 'planning-solid');
    await write(root, 'xforge/changes/add-feature/design.md', '## Decisions\nChanged after approval.\n');
    const stale = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'check'], approvalTestEnv);
    expect(stale.code).toBe(1);
    expect(stale.json.diagnostics.some((item: any) => item.message.includes('approval:planning-solid'))).toBe(true);
  });

  /* P1-9: committing is not a governance event. Evidence binds to content, approvals to governance. */
  it('keeps Approvals and Gate Evidence valid across a commit that changes no governed content', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['install'])).code).toBe(0);
    await initRepository(root);
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);

    /* Committing the Gate Evidence that was just produced must not make that Gate stale. */
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'record gate evidence']);
    const afterGateCommit = await runCli(root, ['state', '--change', 'add-feature']);
    expect(afterGateCommit.json.data.change.governance.readyTransitions.find((item: any) => item.to === 'design').blockedBy).toEqual([]);

    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
    await approveCurrentRevision(root, 'add-feature', 'check', 'planning-solid');

    const before = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(before.json.data.change.governance.readyTransitions.find((item: any) => item.to === 'check').ready).toBe(true);

    /* Commit everything produced so far, exactly as `commitGeneratedFiles: true` would. */
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'record evidence and approval']);
    await write(root, 'unrelated.txt', 'a source file the Change does not govern\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'unrelated work']);

    const after = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(after.json.data.change.governance.revision.gitHead).not.toBe(before.json.data.change.governance.revision.gitHead);
    expect(after.json.data.change.governance.revision.governingRevision).toBe(before.json.data.change.governance.revision.governingRevision);
    const ready = after.json.data.change.governance.readyTransitions.find((item: any) => item.to === 'check');
    expect(ready.blockedBy).toEqual([]);
    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'check'], approvalTestEnv)).code).toBe(0);
  });

  /* P1-8 end to end: the Git author of the Change cannot approve it under a separated policy. */
  it('rejects an approver who implemented the Change and accepts two distinct maintainers', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
      const policy = flow.governance.approvalPolicies.find((item: any) => item.id === 'planning-solid');
      policy.separationOfDuties = true;
      policy.minApprovers = 2;
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    await initRepository(root, 'implementer@example.test', 'Implementer');
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);

    await approveCurrentRevision(root, 'add-feature', 'check', 'planning-solid', 'implementer@example.test', 'maintainer');
    await approveCurrentRevision(root, 'add-feature', 'check', 'planning-solid', 'reviewer@example.test', 'maintainer');
    const separated = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    const blocked = separated.json.data.change.governance.readyTransitions.find((item: any) => item.to === 'check');
    expect(blocked.blockedBy).toEqual(expect.arrayContaining(['approval:planning-solid:separation-of-duties', 'approval:planning-solid:missing-1']));

    await approveCurrentRevision(root, 'add-feature', 'check', 'planning-solid', 'second-reviewer@example.test', 'maintainer');
    const allowed = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(allowed.json.data.change.governance.readyTransitions.find((item: any) => item.to === 'check').blockedBy).toEqual([]);
  });

  /* P1-13: a Stage exit condition is decided from a structured ledger, not from Worker prose. */
  it('does not accept prose for an exit condition and requires an attributed decision', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
      flow.stages.find((stage: any) => stage.id === 'propose').exit = { conditions: { materialQuestions: 'resolved' } };
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);

    const blockedFor = async (): Promise<string[]> => {
      const state = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
      return state.json.data.change.governance.readyTransitions.find((item: any) => item.to === 'design').blockedBy;
    };
    expect(await blockedFor()).toContain('condition:materialQuestions:ledger-missing-expected-resolved');

    /* One prose line in the Agent's own Artifact used to clear the gate. It no longer does. */
    await write(root, 'xforge/changes/add-feature/proposal.md', '## Why\nTest\n\n## Flow choice\nsolid\n\nmaterialQuestions: resolved\nStatus: resolved\n');
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
    expect(await blockedFor()).toContain('condition:materialQuestions:ledger-missing-expected-resolved');

    await write(root, 'xforge/changes/add-feature/evidence/conditions/materialQuestions.yaml', [
      'condition: materialQuestions',
      'entries:',
      '  - id: q1',
      '    question: Does the widget need a migration?',
      '    impact: scope',
      '    decision: ""',
      '    decidedBy: ""',
      '    decidedAt: ""',
      '',
    ].join('\n'));
    expect(await blockedFor()).toContain('condition:materialQuestions:undecided-1');

    await write(root, 'xforge/changes/add-feature/evidence/conditions/materialQuestions.yaml', [
      'condition: materialQuestions',
      'entries:',
      '  - id: q1',
      '    question: Does the widget need a migration?',
      '    impact: scope',
      '    decision: No migration; the widget is additive.',
      '    decidedBy: owner@example.test',
      '    decidedAt: 2026-08-11T10:00:00Z',
      '',
    ].join('\n'));
    expect(await blockedFor()).toEqual([]);
  });

  it('reports mandatory guidance without machine coverage as uncovered', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, 'xforge/scaffold/rules/no-uncovered-write.yaml', [
      'apiVersion: xforge.dev/v1alpha2', 'kind: Rule', 'metadata:', '  name: no-uncovered-write', '  version: 1',
      'spec:', '  severity: must', '  instruction: This rule intentionally has no enforcement coverage.',
      '  scope:', '    paths: [src/**]', '  enforcement:', '    gateRefs: []', '    policyRefs: []', '    approvalRefs: []', '',
    ].join('\n'));
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.rules = ['no-uncovered-write']; });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const state = await runCli(root, ['state', '--change', 'add-feature']);
    const rule = state.json.data.change.governance.rules.find((item: any) => item.id === 'no-uncovered-write');
    expect(rule.coverage).toEqual(expect.arrayContaining(['instructed', 'uncovered']));
  });

  it('rejects a tampered approval receipt on digest, and rejects a hand-forged one on chain corroboration', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
    const approved = await approveCurrentRevision(root, 'add-feature', 'check', 'planning-solid');
    const receiptFile = approved.data.receipt;
    receiptFile.reason = 'tampered after import';
    await write(root, `xforge/changes/add-feature/approvals/planning-solid/${receiptFile.receiptId}.json`, `${JSON.stringify(receiptFile, null, 2)}\n`);
    const state = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(state.code).toBe(1);
    expect(state.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_APPROVAL_RECEIPT_DIGEST_INVALID');
    expect(state.json.data.change.governance.approvals).toEqual([]);
  });
});

describe('Approval verifiability vs validity', () => {
  /*
   * Neither `local` nor `mcp` receipts carry a signature: what makes a receipt trustworthy is that
   * the project's own audit hash chain independently recorded the `approval.decided` event that
   * produced it. A fresh clone or a CI runner never has the gitignored local chain, only the
   * committed per-Change index — and that must still be enough to let a Change advance and archive.
   */
  it('lets a Change advance and archive on a machine with no local audit chain, from the committed index alone', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['install'])).code).toBe(0);
    await successfulCli(root, ['check', '--change', 'add-feature', '--gate', 'structure']);
    await successfulCli(root, ['transition', '--change', 'add-feature', '--to', 'design']);
    await approveCurrentRevision(root, 'add-feature', 'check', 'planning-solid');
    await successfulCli(root, ['transition', '--change', 'add-feature', '--to', 'check']);
    await successfulCli(root, ['check', '--change', 'add-feature']);

    /* Simulate a fresh clone / CI runner: xforge/.audit is gitignored, so it never travels. */
    await rm(path.join(root, 'xforge', '.audit'), { recursive: true, force: true });
    const state = await runCli(root, ['state', '--change', 'add-feature']);
    const ready = state.json.data.change.governance.readyTransitions.find((item: any) => item.to === 'apply');
    expect(ready.ready).toBe(true);
    expect(state.json.diagnostics.some((item: any) => item.code === 'XFORGE_APPROVAL_NOT_IN_AUDIT_CHAIN')).toBe(false);

    const moved = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'apply']);
    expect(moved.code, JSON.stringify(moved.json?.diagnostics)).toBe(0);
    expect(moved.json.data.to).toBe('apply');
  });

  it('still refuses a transition whose own required approval was never produced by xforge approve', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['install'])).code).toBe(0);
    await successfulCli(root, ['check', '--change', 'add-feature', '--gate', 'structure']);
    await successfulCli(root, ['transition', '--change', 'add-feature', '--to', 'design']);
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
      decidedAt: new Date().toISOString(), reason: 'Self-issued, never went through approve.',
    };
    const forged = { ...payload, digest: sha256(stableStringify(payload)) };
    await write(root, `xforge/changes/add-feature/approvals/planning-solid/${forged.receiptId}.json`, `${JSON.stringify(forged, null, 2)}\n`);

    /* A well-formed receipt that never went through `xforge approve` has no audit chain event: the
       approval this transition needs is still missing. */
    const blocked = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'check']);
    expect(blocked.code).toBe(1);
    expect(blocked.json.diagnostics.some((item: any) => item.message.includes('approval:planning-solid'))).toBe(true);
  });
});
