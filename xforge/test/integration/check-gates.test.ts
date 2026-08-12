import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stableStringify, sha256 } from '../../src/core/hash.js';
import { createCompleteSolidChange, fixture, runCli, updateYaml } from '../helpers.js';

describe('check and Gate evidence', () => {
  it('runs only the current Stage Gates, not the verify Stage set', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', "require('node:fs').writeFileSync('unit-tests-ran', 'yes')"];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);

    /* xforge-propose runs `check --change` while still in propose; solid's propose Stage declares
       only the structure Gate, so the 900s test and audit Gates must not run here. */
    const proposeCheck = await runCli(root, ['check', '--change', 'add-feature']);
    expect(proposeCheck.code).toBe(0);
    expect(proposeCheck.json.data).toMatchObject({ stage: 'propose', gateSelection: 'stage' });
    expect(proposeCheck.json.data.gates.map((gate: any) => gate.id)).toEqual(['structure']);
    expect(existsSync(path.join(root, 'unit-tests-ran'))).toBe(false);

    /* The Stage override still allows running another Stage's Gates on demand. */
    const staged = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'stage:verify']);
    expect(staged.code).toBe(0);
    expect(staged.json.data.gates.map((gate: any) => gate.id)).toEqual(['structure', 'unit-tests']);
    expect(existsSync(path.join(root, 'unit-tests-ran'))).toBe(true);

    /* And `--gate all` runs everything the Flow can ever require, which is what archive needs. */
    const all = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'all']);
    expect(all.json.data).toMatchObject({ gateSelection: 'all', stage: null });
    /* Solid now has a Check Stage, so the whole-Flow set includes its findings Gate. */
    expect(all.json.data.gates.map((gate: any) => gate.id)).toEqual(['structure', 'check-findings', 'constitution-check', 'unit-tests']);

    /* The same two overrides as first-class flags, so callers do not have to know that `--gate`
       doubles as a sentinel channel. Both must agree with the sentinel form exactly. */
    const flagStage = await runCli(root, ['check', '--change', 'add-feature', '--stage', 'verify']);
    expect(flagStage.code).toBe(0);
    expect(flagStage.json.data.gates.map((gate: any) => gate.id)).toEqual(staged.json.data.gates.map((gate: any) => gate.id));
    const flagAll = await runCli(root, ['check', '--change', 'add-feature', '--all-gates']);
    expect(flagAll.code).toBe(0);
    expect(flagAll.json.data).toMatchObject({ gateSelection: 'all', stage: null });
    expect(flagAll.json.data.gates.map((gate: any) => gate.id)).toEqual(['structure', 'check-findings', 'constitution-check', 'unit-tests']);

    /* A Stage the Flow does not declare must say so rather than silently running nothing. */
    const unknown = await runCli(root, ['check', '--change', 'add-feature', '--stage', 'nope']);
    expect(unknown.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CHECK_STAGE_UNKNOWN');
  });

  /*
   * A live Major run passed all three Check-Stage Gates and still could not leave the Stage: the
   * Agent ran `structure`, wrote the two Evidence ledgers, then ran the ledger Gates, so `structure`
   * was bound to a content revision two writes old. Every Gate said `passed` and the only signal
   * was `gate:structure:missing-or-stale`, which does not say what to do about it.
   */
  it('distinguishes a missing, a failed, and a stale Gate, and offers the remedy only for stale', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const proposalPath = path.join(root, 'xforge', 'changes', 'add-feature', 'proposal.md');
    const blocks = async (): Promise<string[]> => {
      const result = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design']);
      return result.json.diagnostics
        .filter((item: any) => item.code === 'XFORGE_TRANSITION_BLOCKED')
        .map((item: any) => item.message.replace(/^Transition is blocked by |\.$/g, ''));
    };
    const hasRemedy = async (): Promise<boolean> => {
      const result = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design']);
      return result.json.diagnostics.some((item: any) => item.code === 'XFORGE_GATE_EVIDENCE_STALE_REMEDY');
    };

    /* Never run: the Gate is missing, not stale. Re-running check is the fix, but the sentence
       about editing after a Gate ran would be describing something that never happened. */
    expect(await blocks()).toContain('gate:structure:missing');
    expect(await hasRemedy()).toBe(false);

    /* Ran and genuinely failed: the finding must be fixed, and telling the caller to re-run
       check would point away from it. This is the case that made the conflation harmful. */
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow: any) => {
      flow.stages.find((stage: any) => stage.id === 'propose').gates = ['structure', 'unit-tests'];
    });
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', 'process.exit(7)'];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    await runCli(root, ['check', '--change', 'add-feature']);
    /* The Evidence filename comes from the Gate's `spec.evidence`, not from its id. */
    expect(JSON.parse(await readFile(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'tests.json'), 'utf8')).status).toBe('failed');
    expect(await blocks()).toContain('gate:unit-tests:failed');
    expect(await hasRemedy()).toBe(false);

    /* Passed, then an edit moved the content revision underneath it. Only this one is stale. */
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', 'process.exit(0)'];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['check', '--change', 'add-feature'])).code).toBe(0);
    await writeFile(proposalPath, '\n<!-- a later edit -->\n', { flag: 'a' });
    const stale = await blocks();
    expect(stale).toContain('gate:structure:stale');
    expect(stale).toContain('gate:unit-tests:stale');
    expect(await hasRemedy()).toBe(true);
  });

  it('tells a blocked caller how to clear a stale Gate instead of only naming it', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['check', '--change', 'add-feature'])).code).toBe(0);
    /* Any write after the Gate ran moves contentRevision and strands the Evidence just earned. */
    await writeFile(path.join(root, 'xforge', 'changes', 'add-feature', 'proposal.md'), '\n<!-- a later edit -->\n', { flag: 'a' });
    const blocked = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design']);
    const codes = blocked.json.diagnostics.map((item: any) => item.code);
    expect(codes).toContain('XFORGE_TRANSITION_BLOCKED');
    expect(codes).toContain('XFORGE_GATE_EVIDENCE_STALE_REMEDY');
    const remedy = blocked.json.diagnostics.find((item: any) => item.code === 'XFORGE_GATE_EVIDENCE_STALE_REMEDY');
    expect(remedy.severity).toBe('info');
    expect(remedy.message).toContain('xforge check --change add-feature');
    /* Not `--all-gates`: that would run Gates from Stages the Change has not reached. */
    expect(remedy.message).not.toContain('--all-gates');

    /* And the remedy has to actually work. */
    expect((await runCli(root, ['check', '--change', 'add-feature'])).code).toBe(0);
    const cleared = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design']);
    expect(cleared.json.diagnostics.map((item: any) => item.code)).not.toContain('XFORGE_GATE_EVIDENCE_STALE_REMEDY');
  });

  it('runs mandatory Gates, redacts output, and writes verifiable Evidence', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', "console.log('TOKEN=supersecret'); if (process.env.MY_SECRET) process.exit(9)"];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'all'], { MY_SECRET: 'must-not-be-passed' });
    expect(result.code).toBe(0);
    expect(result.json.data.gates.map((gate: any) => [gate.id, gate.status])).toEqual([
      ['structure', 'passed'], ['check-findings', 'passed'], ['constitution-check', 'passed'], ['unit-tests', 'passed'],
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
    const result = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'all']);
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
    const result = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'all']);
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
    const result = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'all']);
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
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'all'])).code).toBe(0);
    const evidence = JSON.parse(await readFile(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'tests.json'), 'utf8'));
    expect(evidence.outputTruncated).toBe(true);
    expect(Buffer.byteLength(evidence.stdout)).toBe(1024);
  });

  it('passes the declared environment allowlist to a Gate but never a credential-shaped name', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.env = { allow: ['MY_BUILD_FLAG', 'MY_API_KEY'] };
      gate.spec.command = [process.execPath, '-e', "console.log(JSON.stringify({ flag: process.env.MY_BUILD_FLAG ?? null, ci: process.env.CI ?? null, registry: process.env.npm_config_registry ?? null, key: process.env.MY_API_KEY ?? null, other: process.env.UNDECLARED_VARIABLE ?? null }))"];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'unit-tests'], {
      MY_BUILD_FLAG: 'on', MY_API_KEY: 'must-not-be-passed', UNDECLARED_VARIABLE: 'nope', CI: 'true', npm_config_registry: 'https://registry.example.test/',
    });
    expect(result.code).toBe(0);
    const evidence = JSON.parse(await readFile(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'tests.json'), 'utf8'));
    expect(JSON.parse(evidence.stdout)).toEqual({
      flag: 'on', ci: 'true', registry: 'https://registry.example.test/', key: null, other: null,
    });
  });
});
