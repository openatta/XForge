import { access, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { advanceSolidToApply, approvalTestEnv, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';
import { sha256, stableStringify } from '../../src/core/hash.js';

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

  it('skips a current verify pass and re-runs it under --force', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const { binding } = await dispatchWithCommittedReceipt(root);
    const base = await git(root, ['rev-parse', 'HEAD']);
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker T001']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, delivery(binding, {
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/order/refund.ts'],
      validation: [{ command: verify, exit_code: 0 }],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: [`verify:${verify}`, 'src/order/refund.ts'] }],
    }));

    const evidencePath = 'xforge/changes/add-feature/evidence/agents/T001/verify-1.json';
    const first = await runCli(root, ['check', '--change', 'add-feature'], approvalTestEnv);
    expect(first.code, JSON.stringify(first.json.diagnostics, null, 2)).toBe(0);
    expect(first.json.changes).toContainEqual(expect.objectContaining({ action: 'create', path: evidencePath }));

    /* Same HEAD, same Gate definition, same structure: the recorded pass is still current, so a
       plain check reuses it instead of paying for another command run. */
    const second = await runCli(root, ['check', '--change', 'add-feature'], approvalTestEnv);
    expect(second.code, JSON.stringify(second.json.diagnostics, null, 2)).toBe(0);
    expect(second.json.changes).toContainEqual(expect.objectContaining({ action: 'skip', path: evidencePath, reason: 'Already current.' }));
    expect(second.json.changes).not.toContainEqual(expect.objectContaining({ action: 'modify', path: evidencePath }));
    expect(second.json.data.workPackages).toEqual([
      expect.objectContaining({ packageId: 'T001', command: verify, status: 'passed' }),
    ]);

    /* --force bypasses the reuse path and executes the verify command again. */
    const forced = await runCli(root, ['check', '--change', 'add-feature', '--force'], approvalTestEnv);
    expect(forced.code, JSON.stringify(forced.json.diagnostics, null, 2)).toBe(0);
    expect(forced.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: evidencePath }));
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

  /*
   * A live run produced all three of these at once: the harness recorded a delivery whose whole
   * diff was the dispatch receipt and the audit index XForge had just written itself, mapped every
   * done_when criterion to those same two files, and took base_commit from the HEAD the receipt
   * recorded rather than the commit that introduced it. Only the write_paths check objected, and it
   * objected for the wrong reason.
   */
  async function dispatchWithCommittedReceipt(root: string): Promise<{ base: string; binding: any; receiptPath: string }> {
    await initializeGit(root);
    await advanceSolidToApply(root);
    /* Commit everything the planning Stages produced first, so the dispatch commit below contains
       the receipt and nothing else. `base` is the pre-dispatch commit on purpose: tests that record
       a valid delivery re-derive it from HEAD after this returns (a Worker must start from the
       commit that contains the dispatch receipt), while the base-precedes-dispatch validations use
       the pre-dispatch commit as their trigger. */
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'advanced to apply']);
    const base = await git(root, ['rev-parse', 'HEAD']);
    const dispatch = await runCli(root, ['work-package', 'dispatch', '--change', 'add-feature', '--package', 'T001'], approvalTestEnv);
    expect(dispatch.code, JSON.stringify(dispatch.json.diagnostics, null, 2)).toBe(0);
    const binding = dispatch.json.data.receipt;
    const receiptPath = `xforge/changes/add-feature/evidence/agents/T001/dispatch/${binding.executionId}.json`;
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'dispatched T001']);
    return { base, binding, receiptPath };
  }

  function delivery(binding: any, overrides: Record<string, unknown>): string {
    return stringify({
      execution_id: binding.executionId,
      recorded_at: '2026-08-12T00:00:00.000Z',
      status: 'succeeded',
      package_id: 'T001',
      issues: [],
      state_revision: binding.stateRevision,
      policy_snapshot_digest: binding.policySnapshotDigest,
      audit_correlation_id: binding.auditCorrelationId,
      ...overrides,
    });
  }

  it('rejects a base_commit that predates the commit introducing the dispatch receipt', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const { base, binding } = await dispatchWithCommittedReceipt(root);
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker T001']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    /* `base` is the pre-dispatch commit, so the receipt XForge wrote lands inside base..head. */
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, delivery(binding, {
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/order/refund.ts'],
      validation: [{ command: verify, exit_code: 0 }],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: ['src/order/refund.ts'] }],
    }));
    const result = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_WORK_PACKAGE_BASE_PRECEDES_DISPATCH');
  });

  it('rejects a delivery whose entire diff is the control plane\'s own bookkeeping', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const { base, binding, receiptPath } = await dispatchWithCommittedReceipt(root);
    const head = await git(root, ['rev-parse', 'HEAD']);
    const changed = (await git(root, ['diff', '--name-only', `${base}..${head}`])).split('\n').filter(Boolean).sort();
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, delivery(binding, {
      base_commit: base,
      head_commit: head,
      changed_paths: changed,
      validation: [{ command: verify, exit_code: 0 }],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: [receiptPath] }],
    }));
    const result = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(result.code).toBe(1);
    const codes = result.json.diagnostics.map((item: any) => item.code);
    /* The escape check also fires, but it blames the worker for a path XForge itself wrote. This
       says what actually went wrong: the package delivered nothing. */
    expect(codes).toContain('XFORGE_WORK_PACKAGE_NO_WORK_DELIVERED');
    /* And the dispatch receipt is not evidence that the work was done. */
    expect(codes).toContain('XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_IRRELEVANT');
  });

  /*
   * The base_commit-precedes-dispatch check only guards against the control plane's own dispatch
   * commit landing in range. It doesn't help when a different control-plane write — e.g. an
   * unrelated `xforge` invocation appending to the audit index mid-delivery — is swept into
   * base..head for an ordinary commit-ordering reason that has nothing to do with dispatch. That
   * write is still not attributable to the Worker, so it must not trip write_paths either.
   */
  it('does not flag an incidental control-plane bookkeeping write inside the delivery range as a write escape', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const { binding } = await dispatchWithCommittedReceipt(root);
    /* The delivery range starts at the dispatch commit, not before it — a base_commit that
       predates the dispatch receipt trips XFORGE_WORK_PACKAGE_BASE_PRECEDES_DISPATCH regardless of
       this test's own bookkeeping-exemption scenario, which is covered separately. */
    const base = await git(root, ['rev-parse', 'HEAD']);
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker T001']);
    /* Simulate a concurrent, unrelated `xforge` command appending to the audit index while the
       Worker was still delivering, so the audit index change lands in base..head alongside the
       worker's real output rather than as the dispatch commit itself. */
    await write(root, 'xforge/changes/add-feature/evidence/audit/index.json', '{"events":[]}\n');
    await git(root, ['add', 'xforge/changes/add-feature/evidence/audit/index.json']);
    await git(root, ['commit', '-qm', 'concurrent audit index update']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, delivery(binding, {
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/order/refund.ts', 'xforge/changes/add-feature/evidence/audit/index.json'],
      validation: [{ command: verify, exit_code: 0 }],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: ['src/order/refund.ts'] }],
    }));
    const result = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    const codes = result.json.diagnostics.map((item: any) => item.code);
    expect(codes).not.toContain('XFORGE_WORK_PACKAGE_WRITE_ESCAPE');
    expect(codes).not.toContain('XFORGE_WORK_PACKAGE_BASE_PRECEDES_DISPATCH');
    expect(result.json.data.change.workPackages.packages[0].status).toBe('succeeded');
  });

  it('still flags a genuine out-of-scope Worker-authored file alongside an incidental bookkeeping write', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const { binding } = await dispatchWithCommittedReceipt(root);
    const base = await git(root, ['rev-parse', 'HEAD']);
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await write(root, 'src/payment/escaped.ts', 'export const escaped = true;\n');
    await git(root, ['add', 'src/order/refund.ts', 'src/payment/escaped.ts']);
    await git(root, ['commit', '-qm', 'worker T001 with an out-of-scope file']);
    await write(root, 'xforge/changes/add-feature/evidence/audit/index.json', '{"events":[]}\n');
    await git(root, ['add', 'xforge/changes/add-feature/evidence/audit/index.json']);
    await git(root, ['commit', '-qm', 'concurrent audit index update']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, delivery(binding, {
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/order/refund.ts', 'src/payment/escaped.ts', 'xforge/changes/add-feature/evidence/audit/index.json'],
      validation: [{ command: verify, exit_code: 0 }],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: ['src/order/refund.ts'] }],
    }));
    const result = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(result.code).toBe(1);
    const codes = result.json.diagnostics.map((item: any) => item.code);
    expect(codes).toContain('XFORGE_WORK_PACKAGE_WRITE_ESCAPE');
    expect(codes).not.toContain('XFORGE_WORK_PACKAGE_BASE_PRECEDES_DISPATCH');
    expect(result.json.diagnostics.some((item: any) => item.message?.includes('src/payment/escaped.ts'))).toBe(true);
    expect(result.json.data.change.workPackages.packages[0].status).toBe('failed');
  });

  it('rejects done_when evidence that names neither a verify command nor a changed path', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const { binding } = await dispatchWithCommittedReceipt(root);
    const base = await git(root, ['rev-parse', 'HEAD']);
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker T001']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, delivery(binding, {
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/order/refund.ts'],
      validation: [{ command: verify, exit_code: 0 }],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: ['we ran the tests and they passed'] }],
    }));
    const result = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_IRRELEVANT');
  });

  it('accepts a delivery based on the dispatch commit with evidence that names real output', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const { binding } = await dispatchWithCommittedReceipt(root);
    const base = await git(root, ['rev-parse', 'HEAD']);
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker T001']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, delivery(binding, {
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/order/refund.ts'],
      validation: [{ command: verify, exit_code: 0 }],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: [verify, 'src/order/refund.ts'] }],
    }));
    const result = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    const codes = result.json.diagnostics.map((item: any) => item.code);
    expect(codes).not.toContain('XFORGE_WORK_PACKAGE_BASE_PRECEDES_DISPATCH');
    expect(codes).not.toContain('XFORGE_WORK_PACKAGE_NO_WORK_DELIVERED');
    expect(codes).not.toContain('XFORGE_WORK_PACKAGE_DONE_WHEN_EVIDENCE_IRRELEVANT');
    expect(result.json.data.change.workPackages.packages[0].status).toBe('succeeded');
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

  it('writes Git-visible acknowledgement receipts that keep reviewed status through a lost local chain', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const { binding } = await dispatchWithCommittedReceipt(root);
    const base = await git(root, ['rev-parse', 'HEAD']);
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker T001']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    const deliveryYaml = delivery(binding, {
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/order/refund.ts'],
      validation: [{ command: verify, exit_code: 0 }],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: [`verify:${verify}`, 'src/order/refund.ts'] }],
    });
    const deliveryPath = `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`;
    await write(root, deliveryPath, deliveryYaml);

    const checked = await runCli(root, ['check', '--change', 'add-feature'], approvalTestEnv);
    expect(checked.code, JSON.stringify(checked.json?.diagnostics ?? checked.stderr, null, 2)).toBe(0);

    const integrationEvidence = 'xforge/changes/add-feature/evidence/agents/T001/integration.md';
    await write(root, integrationEvidence, 'Integrated T001 and reran contract verification.\n');
    const integrated = await runCli(root, ['work-package', 'acknowledge', '--change', 'add-feature', '--package', 'T001', '--as', 'integrator', '--evidence', integrationEvidence], approvalTestEnv);
    expect(integrated.code, JSON.stringify(integrated.json.diagnostics, null, 2)).toBe(0);
    const integratorReceiptPath = `xforge/changes/add-feature/evidence/agents/T001/acknowledgements/${binding.executionId}-integrator.json`;
    expect(integrated.json.changes).toContainEqual(expect.objectContaining({ action: 'create', path: integratorReceiptPath }));
    const integratorReceipt = JSON.parse(await readFile(path.join(root, ...integratorReceiptPath.split('/')), 'utf8'));
    expect(integratorReceipt).toMatchObject({
      kind: 'WorkPackageAckReceipt', change: 'add-feature', packageId: 'T001', role: 'integrator', status: 'integrated',
      executionId: binding.executionId, auditCorrelationId: binding.auditCorrelationId, evidence: integrationEvidence,
    });
    /* The receipt must be bound to the delivery's bytes, not just its ids. */
    expect(integratorReceipt.deliveryDigest).toBe(sha256(Buffer.from(deliveryYaml)));

    const reviewEvidence = 'xforge/changes/add-feature/evidence/agents/T001/review.md';
    await write(root, reviewEvidence, 'Independent review passed.\n');
    const reviewed = await runCli(root, ['work-package', 'acknowledge', '--change', 'add-feature', '--package', 'T001', '--as', 'reviewer', '--evidence', reviewEvidence], approvalTestEnv);
    expect(reviewed.code).toBe(0);
    const reviewerReceiptPath = `xforge/changes/add-feature/evidence/agents/T001/acknowledgements/${binding.executionId}-reviewer.json`;
    expect(await exists(path.join(root, ...reviewerReceiptPath.split('/')))).toBe(true);

    /* Simulate a lost local chain (pruned or hand-deleted): the committed audit index attests both
       receipts, so status derivation must still read reviewed from the Git-visible files. */
    await rm(path.join(root, 'xforge', '.audit'), { recursive: true, force: true });
    const cloned = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(cloned.code, JSON.stringify(cloned.json.diagnostics, null, 2)).toBe(0);
    expect(cloned.json.data.change.workPackages.packages[0].status).toBe('reviewed');
    expect(cloned.json.data.change.workPackages.packages[0].acknowledgements).toHaveLength(2);
  });

  it('ignores an acknowledgement receipt the audit chain never attested', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const verify = `${process.execPath} -e "process.exit(0)"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', plan([
      workPackage('T001', { write_paths: ['src/order/**'], verify: [verify] }),
    ]));
    const { binding } = await dispatchWithCommittedReceipt(root);
    const base = await git(root, ['rev-parse', 'HEAD']);
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await git(root, ['add', 'src/order/refund.ts']);
    await git(root, ['commit', '-qm', 'worker T001']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    const deliveryYaml = delivery(binding, {
      base_commit: base,
      head_commit: head,
      changed_paths: ['src/order/refund.ts'],
      validation: [{ command: verify, exit_code: 0 }],
      done_when_evidence: [{ criterion: 'T001 is covered by an automated check', evidence: [`verify:${verify}`, 'src/order/refund.ts'] }],
    });
    await write(root, `xforge/changes/add-feature/evidence/agents/T001/${binding.executionId}.yaml`, deliveryYaml);
    const checked = await runCli(root, ['check', '--change', 'add-feature'], approvalTestEnv);
    expect(checked.code, JSON.stringify(checked.json?.diagnostics ?? checked.stderr, null, 2)).toBe(0);

    /* Hand-place a well-formed receipt (valid digest, valid binding) that never went through
       `work-package acknowledge`: no chain event attests it, so it must not drive status. */
    const unsigned = {
      apiVersion: 'xforge.dev/v1alpha2',
      kind: 'WorkPackageAckReceipt',
      change: 'add-feature',
      packageId: 'T001',
      role: 'reviewer',
      status: 'reviewed',
      executionId: binding.executionId,
      auditCorrelationId: binding.auditCorrelationId,
      deliveryDigest: sha256(Buffer.from(deliveryYaml)),
      evidence: 'xforge/changes/add-feature/evidence/agents/T001/review.md',
      stateRevision: binding.stateRevision,
      policySnapshotDigest: binding.policySnapshotDigest,
      gitBase: binding.gitBase,
      gitHead: binding.gitHead,
      acknowledgedAt: '2026-08-13T00:00:00.000Z',
    };
    const forged = { ...unsigned, digest: sha256(stableStringify(unsigned)) };
    await write(
      root,
      `xforge/changes/add-feature/evidence/agents/T001/acknowledgements/${binding.executionId}-reviewer.json`,
      `${JSON.stringify(forged, null, 2)}\n`,
    );

    const result = await runCli(root, ['state', '--change', 'add-feature'], approvalTestEnv);
    expect(result.code).toBe(0);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_WORK_PACKAGE_ACK_UNATTESTED');
    expect(result.json.data.change.workPackages.packages[0].status).toBe('succeeded');
    expect(result.json.data.change.workPackages.packages[0].acknowledgements).toEqual([]);
  });
});
