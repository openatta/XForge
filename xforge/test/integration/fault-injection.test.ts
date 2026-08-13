import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { executeApprove, type ApprovalTerminal } from '../../src/commands/approve.js';
import { readChangeLogEvents, verifyAudit } from '../../src/core/audit.js';
import { loadProject } from '../../src/core/project-loader.js';
import { advanceSolidToApply, approvalTestEnv, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

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

async function command(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await command(root, args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initializeGit(root: string): Promise<string> {
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'XForge Test']);
  await git(root, ['config', 'user.email', 'test@example.test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'base']);
  return git(root, ['rev-parse', 'HEAD']);
}

function plan(packages: Array<Record<string, unknown>>): string {
  return stringify({ apiVersion: 'xforge.dev/v1alpha1', kind: 'WorkPackagePlan', packages }, { lineWidth: 120 });
}

/** Brings a fixture Change through to the apply Stage with one work package T001 whose gates are
 * softened to pass, ready for dispatch/acknowledge fault injection. */
async function readyToDispatch(root: string): Promise<void> {
  await createCompleteSolidChange(root);
  const verify = `${process.execPath} -e "process.exit(0)"`;
  await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([{
    id: 'T001', goal: 'Implement T001', depends_on: [],
    inputs: ['xforge/changes/add-feature/design.md'], write_paths: ['src/order/**'],
    skills: ['xforge-apply'], verify: [verify], done_when: ['T001 is covered by an automated check'],
  }]));
  await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
    gate.spec.command = [process.execPath, '-e', 'process.exit(0)'];
  });
  const installed = await runCli(root, ['install', '--target', 'codex']);
  expect(installed.code, JSON.stringify(installed.json.diagnostics, null, 2)).toBe(0);
  await initializeGit(root);
  await advanceSolidToApply(root);
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

  it('leaves no dispatch receipt and no event when the record fails before append (dispatch)', async () => {
    const root = await fixture();
    await readyToDispatch(root);
    const dispatchDir = path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'agents', 'T001', 'dispatch');

    const result = await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], { ...approvalTestEnv, ...RECORD_FAULT });
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INTERNAL_ERROR');
    expect(await readdir(dispatchDir).catch(() => [] as string[])).toEqual([]);
    const events = await readChangeLogEvents(await loadProject(root, { exactRoot: true }), 'add-feature');
    expect(events.some((event) => event.eventType === 'work-package.dispatched')).toBe(false);

    /* The failed run leaves the package ready: a plain retry dispatches normally. */
    expect((await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], approvalTestEnv)).code).toBe(0);
  });

  it('rolls back the dispatch receipt but keeps the dispatched event when the index write fails', async () => {
    const root = await fixture();
    await readyToDispatch(root);
    const dispatchDir = path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'agents', 'T001', 'dispatch');

    const result = await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], { ...approvalTestEnv, ...INDEX_FAULT });
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INTERNAL_ERROR');
    expect(await readdir(dispatchDir).catch(() => [] as string[])).toEqual([]);

    /* The event is already on the chain and the chain still verifies: only the command failed. */
    const project = await loadProject(root, { exactRoot: true });
    const events = await readChangeLogEvents(project, 'add-feature');
    expect(events.some((event) => event.eventType === 'work-package.dispatched')).toBe(true);
    expect((await verifyAudit(project)).valid).toBe(true);

    expect((await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], approvalTestEnv)).code).toBe(0);
  });

  it('rolls back the acknowledgement receipt but keeps the integrated event when the index write fails', async () => {
    const root = await fixture();
    await readyToDispatch(root);
    const dispatch = await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], approvalTestEnv);
    expect(dispatch.code, JSON.stringify(dispatch.json.diagnostics, null, 2)).toBe(0);
    const binding = dispatch.json.data.receipt;
    const base = await git(root, ['rev-parse', 'HEAD']);

    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker T001']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, stringify({
      execution_id: binding.executionId,
      recorded_at: '2026-08-13T00:00:00.000Z',
      status: 'succeeded',
      package_id: 'T001',
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/order/refund.ts'],
      validation: [{ command: verify, exit_code: 0 }],
      issues: [],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: [`verify:${verify}`, 'src/order/refund.ts'] }],
      state_revision: binding.stateRevision,
      policy_snapshot_digest: binding.policySnapshotDigest,
      audit_correlation_id: binding.auditCorrelationId,
    }));
    const checked = await runCli(root, ['check', '--change', 'add-feature'], approvalTestEnv);
    expect(checked.code, JSON.stringify(checked.json?.diagnostics ?? checked.stderr, null, 2)).toBe(0);

    const integrationEvidence = 'xforge/changes/add-feature/evidence/agents/T001/integration.md';
    await write(root, integrationEvidence, 'Integrated T001 and reran contract verification.\n');
    const ackDir = path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'agents', 'T001', 'acknowledgements');
    const ack = await runCli(root, ['work-package', 'acknowledge', '--change', 'add-feature', '--package', 'T001', '--as', 'integrator', '--evidence', integrationEvidence], { ...approvalTestEnv, ...INDEX_FAULT });
    expect(ack.code).toBe(1);
    expect(ack.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_INTERNAL_ERROR');
    expect(await readdir(ackDir).catch(() => [] as string[])).toEqual([]);

    /* The event is already on the chain and the chain still verifies: only the command failed. */
    const project = await loadProject(root, { exactRoot: true });
    const events = await readChangeLogEvents(project, 'add-feature');
    expect(events.some((event) => event.eventType === 'work-package.integrated')).toBe(true);
    expect((await verifyAudit(project)).valid).toBe(true);
  });
});
