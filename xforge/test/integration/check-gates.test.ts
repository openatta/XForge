import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stableStringify, sha256 } from '../../src/core/hash.js';
import { createCompleteSolidChange, fixture, runCli, updateYaml } from '../helpers.js';

describe('check and Gate evidence', () => {
  it('runs mandatory Gates, redacts output, and writes verifiable Evidence', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', "console.log('TOKEN=supersecret'); if (process.env.MY_SECRET) process.exit(9)"];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['check', '--change', 'add-feature'], { MY_SECRET: 'must-not-be-passed' });
    expect(result.code).toBe(0);
    expect(result.json.data.gates.map((gate: any) => [gate.id, gate.status])).toEqual([
      ['structure', 'passed'], ['unit-tests', 'passed'],
    ]);
    const evidencePath = path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'tests.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    expect(evidence.stdout).toContain('TOKEN=[REDACTED]');
    expect(evidence.stdout).not.toContain('supersecret');
    expect(evidence.change).toBe('add-feature');
    expect(evidence.exitCode).toBe(0);
    const { digest, ...unsigned } = evidence;
    expect(digest).toBe(sha256(stableStringify(unsigned)));
  });

  it('fails mandatory Gates and preserves traceable failed Evidence', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', "process.stderr.write('failed test'); process.exit(7)"];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['check', '--change', 'add-feature']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_GATE_FAILED');
    const evidence = JSON.parse(await readFile(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'tests.json'), 'utf8'));
    expect(evidence).toMatchObject({ status: 'failed', exitCode: 7, change: 'add-feature' });
  });

  it('does not overwrite hand-written Evidence', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const { write } = await import('../helpers.js');
    await write(root, 'xforge/changes/add-feature/evidence/tests.json', '{"claimed":"pass"}\n');
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => { gate.spec.command = [process.execPath, '-e', 'process.exit(0)']; });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['check', '--change', 'add-feature']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_EVIDENCE_CONFLICT');
    expect(await readFile(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'tests.json'), 'utf8')).toBe('{"claimed":"pass"}\n');
  });

  it('enforces timeout even when a child ignores SIGTERM', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.timeoutSeconds = 1;
      gate.spec.command = [process.execPath, '-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['check', '--change', 'add-feature']);
    expect(result.code).toBe(1);
    const evidence = JSON.parse(await readFile(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'tests.json'), 'utf8'));
    expect(evidence).toMatchObject({ status: 'failed', timedOut: true });
  }, 10_000);

  it('caps raw command output recorded in Evidence', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.maxOutputBytes = 1024;
      gate.spec.command = [process.execPath, '-e', "process.stdout.write('x'.repeat(5000))"];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['check', '--change', 'add-feature'])).code).toBe(0);
    const evidence = JSON.parse(await readFile(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'tests.json'), 'utf8'));
    expect(evidence.outputTruncated).toBe(true);
    expect(Buffer.byteLength(evidence.stdout)).toBe(1024);
  });
});
