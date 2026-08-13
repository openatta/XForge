import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeApprove, type ApprovalTerminal } from '../../src/commands/approve.js';
import { readChangeLogEvents, verifyAudit } from '../../src/core/audit.js';
import { loadProject } from '../../src/core/project-loader.js';
import { createCompleteSolidChange, fixture, runCli } from '../helpers.js';

/**
 * Fault-injection coverage for the write-then-audit compensation paths: the audit chain must
 * never claim something was decided that the command's output files do not back, and vice versa.
 */
const RECORD_FAULT = { XFORGE_FAULT_AUDIT_RECORD: '1' };
const INDEX_FAULT = { XFORGE_FAULT_AUDIT_INDEX: '1' };

const transitionsDir = (root: string): string => path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'receipts', 'transitions');
const approvalsDir = (root: string): string => path.join(root, 'xforge', 'changes', 'add-feature', 'approvals', 'planning-solid');
const evidenceDir = (root: string): string => path.join(root, 'xforge', 'changes', 'add-feature', 'evidence');

afterEach(() => {
  delete process.env.XFORGE_FAULT_AUDIT_RECORD;
  delete process.env.XFORGE_FAULT_AUDIT_INDEX;
});

async function structurePassed(root: string): Promise<void> {
  await createCompleteSolidChange(root);
  expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
}

async function toDesign(root: string): Promise<void> {
  await structurePassed(root);
  expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
}

function scriptedTerminal(answers: Record<string, string>): ApprovalTerminal {
  return {
    present() {},
    async question(prompt: string) {
      for (const [key, answer] of Object.entries(answers)) if (prompt.includes(key)) return answer;
      return '';
    },
  };
}

function approveDecision(root: string) {
  return loadProject(root, { exactRoot: true }).then((project) => executeApprove(project, {
    change: 'add-feature', transition: 'check', policy: 'planning-solid', interactive: true, dryRun: false,
    terminal: scriptedTerminal({
      'Approver identity': 'owner@example.test', 'Approver role': 'owner',
      'Decision': 'approve', 'Reason': 'Reviewed the design at the terminal.',
    }),
  }));
}

describe('audit fault injection', () => {
  it('leaves no receipt and no audit event when the record fails before append (transition)', async () => {
    const root = await fixture();
    await structurePassed(root);

    const result = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'], RECORD_FAULT);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INTERNAL_ERROR');
    expect(await readdir(transitionsDir(root)).catch(() => [] as string[])).toEqual([]);
    const events = await readChangeLogEvents(await loadProject(root, { exactRoot: true }), 'add-feature');
    expect(events.some((event) => event.eventType === 'stage.entering')).toBe(false);

    /* The failed run leaves the Change untouched: a plain retry succeeds. */
    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
  });

  it('keeps the appended event but refuses the Transition when the index write fails', async () => {
    const root = await fixture();
    await structurePassed(root);

    const result = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'], INDEX_FAULT);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INTERNAL_ERROR');
    expect(await readdir(transitionsDir(root)).catch(() => [] as string[])).toEqual([]);

    /* The event is already on the chain and the chain still verifies: only the command failed. */
    const project = await loadProject(root, { exactRoot: true });
    const events = await readChangeLogEvents(project, 'add-feature');
    expect(events.some((event) => event.eventType === 'stage.entering')).toBe(true);
    expect((await verifyAudit(project)).valid).toBe(true);

    expect((await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design'])).code).toBe(0);
  });

  it('fails an approval before anything is written when the audit record cannot append', async () => {
    const root = await fixture();
    await toDesign(root);
    process.env.XFORGE_FAULT_AUDIT_RECORD = '1';
    await expect(approveDecision(root)).rejects.toThrow('Injected audit record failure');

    expect(await readdir(approvalsDir(root)).catch(() => [] as string[])).toEqual([]);
    const events = await readChangeLogEvents(await loadProject(root, { exactRoot: true }), 'add-feature');
    expect(events.some((event) => event.eventType === 'approval.requested')).toBe(false);
    expect(events.some((event) => event.eventType === 'approval.decided')).toBe(false);

    /* Recovery: the same human decision without the fault records normally. */
    delete process.env.XFORGE_FAULT_AUDIT_RECORD;
    const recovered = await approveDecision(root);
    expect(recovered.data.status).toBe('recorded');
    expect(await readdir(approvalsDir(root))).toHaveLength(1);
  });

  it('keeps the requested event on the chain when the index write fails mid-approval', async () => {
    const root = await fixture();
    await toDesign(root);
    process.env.XFORGE_FAULT_AUDIT_INDEX = '1';
    await expect(approveDecision(root)).rejects.toThrow('Injected audit index failure');

    expect(await readdir(approvalsDir(root)).catch(() => [] as string[])).toEqual([]);
    const events = await readChangeLogEvents(await loadProject(root, { exactRoot: true }), 'add-feature');
    expect(events.some((event) => event.eventType === 'approval.requested')).toBe(true);
    expect(events.some((event) => event.eventType === 'approval.decided')).toBe(false);
  });

  it('writes no Gate evidence when the gate audit record fails', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);

    const result = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'], RECORD_FAULT);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INTERNAL_ERROR');
    expect(await readdir(evidenceDir(root))).not.toContain('structure.json');

    /* A re-run recreates the evidence the chain can then attest. */
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);
  });
});
