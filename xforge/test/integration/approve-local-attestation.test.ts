import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli, updateYaml } from '../helpers.js';

async function toDesign(root: string): Promise<void> {
  await createCompleteSolidChange(root);
  expect((await runCli(root, ['install'])).code).toBe(0);
  expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
  expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
}

const localApproveArgs = [
  'approve', '--change', 'add-feature', '--for', 'apply', '--policy', 'planning-solid',
  '--actor', 'owner@example.test', '--role', 'owner', '--reason', 'Looks good.', '--decision', 'approve', '--attestation', 'human',
];

describe('local approval TTY attestation', () => {
  it('rejects a non-interactive local approval by default', async () => {
    const root = await fixture();
    await toDesign(root);
    const result = await runCli(root, localApproveArgs);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.some((item: any) => item.code === 'XFORGE_APPROVAL_INTERACTIVE_REQUIRED')).toBe(true);
  });

  it('allows a non-interactive local approval when approvals.local.requireTty is false', async () => {
    const root = await fixture();
    await toDesign(root);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.approvals.local = { requireTty: false };
    });
    const result = await runCli(root, localApproveArgs);
    expect(result.code).toBe(0);
    expect(result.json.data.receipt.approver).toEqual({ id: 'owner@example.test', provider: 'local', role: 'owner', type: 'human' });
  });
});
