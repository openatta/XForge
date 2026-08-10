import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { advanceSolidToApply, approvalTestEnv, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

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

function workPackage(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    goal: `Implement ${id}`,
    depends_on: [],
    inputs: ['xforge/changes/add-feature/design.md'],
    write_paths: [`src/${id.toLowerCase()}/**`],
    skills: ['xforge-apply'],
    verify: [`${process.execPath} -e "process.exit(0)"`],
    done_when: [`${id} is covered by an automated check`],
    ...overrides,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

describe('work-package protocol', () => {
  it('accepts only the eight canonical work-package fields', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { forbidden_paths: ['xforge/**'] }),
    ]));

    const result = await runCli(root, ['state', '--change', 'add-feature']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_SCHEMA_INVALID');
    expect(result.json.diagnostics.some((item: any) => item.message.includes('additional properties'))).toBe(true);
  });

  it('returns dependency waves and the currently safe parallel candidate set without requiring delivery during state', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001'),
      workPackage('T002', { write_paths: ['src/two/**'] }),
      workPackage('T003', { depends_on: ['T001', 'T002'] }),
    ]));
    const base = await initializeGit(root);

    const result = await runCli(root, ['state', '--change', 'add-feature']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    expect(result.json.data.change.workPackages).toMatchObject({
      baseCommit: base,
      ready: ['T001', 'T002'],
      waves: [{ index: 1, packages: ['T001', 'T002'] }, { index: 2, packages: ['T003'] }],
      parallelCandidates: ['T001', 'T002'],
      packages: [
        { id: 'T001', status: 'ready', missingDependencies: [] },
        { id: 'T002', status: 'ready', missingDependencies: [] },
        { id: 'T003', status: 'blocked', missingDependencies: ['T001', 'T002'] },
      ],
    });
  });

  it('rejects missing inputs, Skills, parallel write conflicts, and scope escapes', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', {
        inputs: ['missing/spec.md'],
        skills: ['missing-skill'],
        write_paths: ['src/shared/**'],
      }),
      workPackage('T002', { write_paths: ['src/shared/service/**'] }),
      workPackage('T003', { write_paths: ['outside/**'], depends_on: ['T001'] }),
    ]));
    await initializeGit(root);

    const result = await runCli(root, ['state', '--change', 'add-feature']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toEqual(expect.arrayContaining([
      'XFORGE_WORK_PACKAGE_INPUT_MISSING',
      'XFORGE_WORK_PACKAGE_SKILL_MISSING',
      'XFORGE_WORK_PACKAGE_PARALLEL_WRITE_CONFLICT',
      'XFORGE_WORK_PACKAGE_OUTSIDE_CHANGE_SCOPE',
    ]));
  });

  it('rejects dependency cycles and project-declared Integrator-only paths', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, 'xforge/scaffold/rules/shared-contracts.yaml', [
      'apiVersion: xforge.dev/v1alpha1',
      'kind: Rule',
      'metadata:',
      '  name: shared-contracts',
      '  version: 1',
      'spec:',
      '  level: scoped',
      '  instruction: Shared contracts have one Integrator writer.',
      '  paths: [src/contracts/**]',
      '  writePolicy: integrator-only',
      '',
    ].join('\n'));
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.scaffold.rules = ['shared-contracts'];
    });
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { depends_on: ['T002'], write_paths: ['src/contracts/order/**'] }),
      workPackage('T002', { depends_on: ['T001'] }),
    ]));
    await initializeGit(root);

    const result = await runCli(root, ['state', '--change', 'add-feature']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toEqual(expect.arrayContaining([
      'XFORGE_WORK_PACKAGE_DEPENDENCY_CYCLE',
      'XFORGE_WORK_PACKAGE_SHARED_WRITE',
    ]));
  });

  it('does not write a dispatch receipt when the work-package plan is invalid', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([workPackage('T001')]));
    await initializeGit(root);
    await advanceSolidToApply(root);
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { inputs: ['missing/runtime-contract.md'] }),
    ]));

    const result = await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], approvalTestEnv);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_WORK_PACKAGE_INPUT_MISSING');
    expect(await exists(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'agents', 'T001', 'dispatch'))).toBe(false);
  });

  it('validates a Worker commit and reruns verify into bounded XForge Evidence', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', 'process.exit(0)'];
    });
    const installed = await runCli(root, ['install', '--target', 'codex']);
    expect(installed.code, JSON.stringify(installed.json.diagnostics, null, 2)).toBe(0);
    const base = await initializeGit(root);
    await advanceSolidToApply(root);
    const dispatch = await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], approvalTestEnv);
    expect(dispatch.code).toBe(0);
    const binding = dispatch.json.data.receipt;
    const running = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(running.code).toBe(0);
    expect(running.json.data.change.workPackages.packages[0].status).toBe('running');

    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker T001']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, stringify({
      execution_id: binding.executionId,
      recorded_at: '2026-08-08T00:00:00.000Z',
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

    const result = await runCli(root, ['check', '--change', 'add-feature'], approvalTestEnv);
    expect(result.code).toBe(0);
    expect(result.json.data.workPackages).toEqual([
      expect.objectContaining({ packageId: 'T001', command: verify, status: 'passed' }),
    ]);
    const evidencePath = path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'agents', 'T001', 'verify-1.json');
    expect(await exists(evidencePath)).toBe(true);
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    expect(evidence).toMatchObject({ status: 'passed', change: 'add-feature', shell: true });

    const succeeded = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(succeeded.json.data.change.workPackages.packages[0].status).toBe('succeeded');
    const integrationEvidence = 'xforge/changes/add-feature/evidence/agents/T001/integration.md';
    await write(root, integrationEvidence, 'Integrated T001 and reran contract verification.\n');
    const integrated = await runCli(root, ['work-package', 'acknowledge', '--change', 'add-feature', '--package', 'T001', '--as', 'integrator', '--evidence', integrationEvidence], approvalTestEnv);
    expect(integrated.code).toBe(0);
    const integratedState = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(integratedState.json.data.change.workPackages.packages[0].status).toBe('integrated');
    const reviewEvidence = 'xforge/changes/add-feature/evidence/agents/T001/review.md';
    await write(root, reviewEvidence, 'Independent review passed.\n');
    const reviewed = await runCli(root, ['work-package', 'acknowledge', '--change', 'add-feature', '--package', 'T001', '--as', 'reviewer', '--evidence', reviewEvidence], approvalTestEnv);
    expect(reviewed.code).toBe(0);
    const reviewedState = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(reviewedState.json.data.change.workPackages.packages[0].status).toBe('reviewed');
  });

  it('rejects a succeeded delivery without an exact done_when evidence mapping', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const base = await initializeGit(root);
    await advanceSolidToApply(root);
    const dispatch = await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], approvalTestEnv);
    const binding = dispatch.json.data.receipt;
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker without semantic evidence']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, stringify({
      execution_id: binding.executionId,
      recorded_at: '2026-08-08T00:00:00.000Z',
      status: 'succeeded',
      package_id: 'T001',
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/order/refund.ts'],
      validation: [{ command: verify, exit_code: 0 }],
      issues: [],
      state_revision: binding.stateRevision,
      policy_snapshot_digest: binding.policySnapshotDigest,
      audit_correlation_id: binding.auditCorrelationId,
    }));
    const result = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_MISSING');
    expect(result.json.data.change.workPackages.packages[0].status).toBe('failed');
  });

  it('rejects a delivery commit that escapes write_paths even when it claims success', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const base = await initializeGit(root);
    await advanceSolidToApply(root);
    const dispatch = await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], approvalTestEnv);
    expect(dispatch.code).toBe(0);
    const binding = dispatch.json.data.receipt;

    await write(root, 'src/payment/escaped.ts', 'export const escaped = true;\n');
    await git(root, ['add', 'src/payment/escaped.ts']);
    await git(root, ['commit', '-qm', 'escaped worker']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, stringify({
      execution_id: binding.executionId,
      recorded_at: '2026-08-08T00:00:00.000Z',
      status: 'succeeded',
      package_id: 'T001',
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/payment/escaped.ts'],
      validation: [{ command: verify, exit_code: 0 }],
      issues: [],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: [`verify:${verify}`] }],
      state_revision: binding.stateRevision,
      policy_snapshot_digest: binding.policySnapshotDigest,
      audit_correlation_id: binding.auditCorrelationId,
    }));

    const result = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_WORK_PACKAGE_WRITE_ESCAPE');
    expect(result.json.data.change.workPackages.packages[0].status).toBe('failed');
  });

  it('does not trust a claimed validation pass when verify actually fails', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(9)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', 'process.exit(0)'];
    });
    const installed = await runCli(root, ['install', '--target', 'codex']);
    expect(installed.code, JSON.stringify(installed.json.diagnostics, null, 2)).toBe(0);
    const base = await initializeGit(root);
    await advanceSolidToApply(root);
    const dispatch = await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], approvalTestEnv);
    expect(dispatch.code).toBe(0);
    const binding = dispatch.json.data.receipt;

    await write(root, 'src/order/refund.ts', 'export const refund = false;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker claimed pass']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, stringify({
      execution_id: binding.executionId,
      recorded_at: '2026-08-08T00:00:00.000Z',
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

    const result = await runCli(root, ['check', '--change', 'add-feature'], approvalTestEnv);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_WORK_PACKAGE_VERIFY_FAILED');
    expect(result.json.data.workPackages[0].status).toBe('failed');
  });
});
