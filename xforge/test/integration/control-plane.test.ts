import { describe, expect, it } from 'vitest';
import { approveCurrentRevision, approvalTestEnv, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';
import { approvalsForPolicy } from '../../src/core/control-plane.js';

describe('Protocol 2 control plane', () => {
  it('enforces Major two-person role separation', () => {
    const base = { policyId: 'implementation-major', transition: 'apply', stateRevision: 'r1', decision: 'approve', expiresAt: undefined };
    const sameRole = approvalsForPolicy([
      { ...base, approver: { id: 'alice', provider: 'enterprise-hmac', role: 'owner' } },
      { ...base, approver: { id: 'bob', provider: 'enterprise-hmac', role: 'owner' } },
    ] as any, { id: 'implementation-major', minApprovers: 2, roles: ['owner', 'security'], separationOfDuties: true, providers: ['enterprise-hmac'] }, 'apply', 'r1');
    expect(sameRole.missing).toBe(0);
    expect(sameRole.separationSatisfied).toBe(false);
    const separated = approvalsForPolicy([
      { ...base, approver: { id: 'alice', provider: 'enterprise-hmac', role: 'owner' } },
      { ...base, approver: { id: 'sec', provider: 'enterprise-hmac', role: 'security' } },
    ] as any, { id: 'implementation-major', minApprovers: 2, roles: ['owner', 'security'], separationOfDuties: true, providers: ['enterprise-hmac'] }, 'apply', 'r1');
    expect(separated.separationSatisfied).toBe(true);
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
    const approvalBlocked = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'apply', '--dry-run']);
    expect(approvalBlocked.json.diagnostics.some((item: any) => item.message.includes('approval:planning-solid'))).toBe(true);

    await approveCurrentRevision(root, 'add-feature', 'apply', 'planning-solid');
    await write(root, 'xforge/changes/add-feature/design.md', '## Decisions\nChanged after approval.\n');
    const stale = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'apply'], approvalTestEnv);
    expect(stale.code).toBe(1);
    expect(stale.json.diagnostics.some((item: any) => item.message.includes('approval:planning-solid'))).toBe(true);
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

  it('revalidates imported approval signatures on every state load', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
    const approved = await approveCurrentRevision(root, 'add-feature', 'apply', 'planning-solid');
    const receipt = approved.data.receipt;
    receipt.reason = 'tampered after import';
    await write(root, `xforge/changes/add-feature/approvals/planning-solid/${receipt.receiptId}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
    const state = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(state.code).toBe(1);
    expect(state.json.diagnostics.map((item: any) => item.code)).toEqual(expect.arrayContaining(['XFORGE_APPROVAL_RECEIPT_DIGEST_INVALID', 'XFORGE_APPROVAL_SIGNATURE_INVALID']));
    expect(state.json.data.change.governance.approvals).toEqual([]);
  });
});
