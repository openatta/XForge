import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { stableStringify, sha256 } from '../../src/core/hash.js';
import { advanceSolidToApply, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

async function git(root: string, args: string[]): Promise<string> {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initializeGit(root: string): Promise<void> {
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'XForge Test']);
  await git(root, ['config', 'user.email', 'test@example.test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'base']);
}

/**
 * A Change sitting in Apply with one work package whose `verify` command reads a committed source
 * file, in a real Git worktree — the shape every work-package verify reuse question has.
 */
function planWithVerify(verify: string | string[]): string {
  return stringify({
    apiVersion: 'xforge.dev/v1alpha1',
    kind: 'WorkPackagePlan',
    packages: [{
      id: 'T001',
      goal: 'Implement T001',
      depends_on: [],
      inputs: ['xforge/changes/add-feature/design.md'],
      write_paths: ['src/order/**'],
      skills: ['xforge-apply'],
      verify: [verify],
      done_when: ['T001 is covered by an automated check'],
    }],
  }, { lineWidth: 120 });
}

async function applyStageWithVerify(root: string, verify: string | string[], source = 'export const refund = true;\n'): Promise<void> {
  await createCompleteSolidChange(root);
  await write(root, 'src/order/refund.ts', source);
  await write(root, 'xforge/changes/add-feature/work-packages.yaml', planWithVerify(verify));
  await initializeGit(root);
  await advanceSolidToApply(root);
}

const VERIFY_EVIDENCE = ['xforge', 'changes', 'add-feature', 'evidence', 'agents', 'T001', 'verify-1.json'];

/** Mirrors `shellLabel` in core/work-packages.ts: how an argv verify entry is named back. */
function verifyLabel(argv: string[]): string {
  return argv
    .map((token) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token) ? token : `'${token.split("'").join("'\\''")}'`))
    .join(' ');
}

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

  /*
   * The loop XForge exists to govern: an Agent runs `check`, edits source, and runs `check` again
   * without committing. `inputDigest` is derived from the Gate, the governance revision, and the
   * structural pre-check — none of which an uncommitted edit moves — so reuse keyed on it alone
   * reported a verify as passed without ever executing the command.
   */
  it('re-runs a work-package verify after an uncommitted source edit instead of reusing its Evidence', async () => {
    const root = await fixture();
    const verify = [process.execPath, '-e', "process.exit(require('node:fs').readFileSync('src/order/refund.ts','utf8').includes('BROKEN') ? 1 : 0)"];
    await applyStageWithVerify(root, verify);

    const first = await runCli(root, ['check', '--change', 'add-feature']);
    expect(first.code, JSON.stringify(first.json?.diagnostics, null, 2)).toBe(0);
    expect(first.json.data.workPackages).toEqual([
      expect.objectContaining({ packageId: 'T001', command: verifyLabel(verify), status: 'passed', cached: false }),
    ]);

    /* The edit that would now fail the verify. Nothing is committed, so HEAD, the Change's
       Artifacts, and the policy snapshot are all exactly as the passing Evidence recorded them. */
    await writeFile(path.join(root, 'src', 'order', 'refund.ts'), 'export const refund = BROKEN;\n');

    const second = await runCli(root, ['check', '--change', 'add-feature']);
    expect(second.code).toBe(1);
    expect(second.json.data.workPackages[0]).toMatchObject({ packageId: 'T001', status: 'failed', cached: false });
    expect(second.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_WORK_PACKAGE_VERIFY_FAILED');
    /* And the Evidence on disk says failed, so a later transition cannot read the stale pass. */
    expect(JSON.parse(await readFile(path.join(root, ...VERIFY_EVIDENCE), 'utf8'))).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  /*
   * The reachability that made this urgent: work-package plans live under `xforge/changes/**`, which
   * the shipped protected-files policy deliberately leaves writable (lifecycle Skills write Change
   * content there) and which `core/lockfile.ts` does not digest. So editing a plan trips no policy,
   * staleness check, or structure error — and the synthesized verify Gate carried `shell: true`,
   * putting the plan's own text on the far side of `/bin/sh -c` at the next check past Apply.
   */
  it('never executes a legacy verify string that would compose commands in a shell', async () => {
    const root = await fixture();
    const marker = path.join(root, 'shell-was-invoked');
    await applyStageWithVerify(root, [process.execPath, '-e', 'process.exit(0)']);
    /* Edited after the Change was approved into Apply, which nothing prevents: the plan is Change
       content, so no protected-files policy covers it and no lock digest goes stale. Two commands
       joined by `;` — harmless as argv (there is no `;` operator without a shell) and a file write
       under `sh -c`. The marker is the whole difference, so it is what this reads. */
    const verify = `${process.execPath} -e "process.exit(0)" ; ${process.execPath} -e "require('node:fs').writeFileSync('shell-was-invoked','yes')"`;
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', planWithVerify(verify));

    const result = await runCli(root, ['check', '--change', 'add-feature']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_WORK_PACKAGE_VERIFY_UNSAFE');
    expect(existsSync(marker)).toBe(false);
    /* And it never ran at all: refusing at the structural pass means no Gate, no Evidence. */
    expect(existsSync(path.join(root, ...VERIFY_EVIDENCE))).toBe(false);
  });

  it('runs an argv verify entry directly, passing shell metacharacters through as literal arguments', async () => {
    const root = await fixture();
    const marker = path.join(root, 'shell-was-invoked');
    /* The verify passes only if the whole `; ...` word arrived as one literal argv entry, which is
       true exactly when no shell parsed it. If a shell had, it would have written the marker. */
    const hostile = `; ${process.execPath} -e "require('node:fs').writeFileSync('shell-was-invoked','yes')"`;
    const verify = [process.execPath, '-e', `process.exit(process.argv[1] === ${JSON.stringify(hostile)} ? 0 : 1)`, hostile];
    await applyStageWithVerify(root, verify);

    const result = await runCli(root, ['check', '--change', 'add-feature']);
    expect(result.code, JSON.stringify(result.json.diagnostics, null, 2)).toBe(0);
    expect(result.json.data.workPackages[0]).toMatchObject({ packageId: 'T001', command: verifyLabel(verify), status: 'passed' });
    expect(existsSync(marker)).toBe(false);
    const evidence = JSON.parse(await readFile(path.join(root, ...VERIFY_EVIDENCE), 'utf8'));
    /* Evidence records the argv it spawned, not a command line, and says it used no shell. */
    expect(evidence).toMatchObject({ status: 'passed', shell: false, command: verify });
  });

  /*
   * `unit-tests` is `npm test --if-present` and `security-scan` is `npm audit --offline`, both
   * required, both gating the verify Stage of all three Flows. In a project with no Node toolchain
   * the executable is simply absent, and mapping that to XFORGE_GATE_FAILED told the reader their
   * tests failed — a report about code that was never run. It still blocks (an unrunnable required
   * Gate is not a pass); it just has to say what is actually wrong.
   */
  it('reports a Gate whose executable is missing as unavailable tooling, not as a failing check', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = ['xforge-no-such-executable-anywhere', 'test', '--if-present'];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);

    const result = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'all']);
    expect(result.code).toBe(1);
    const codes = result.json.diagnostics.map((item: any) => item.code);
    expect(codes).toContain('XFORGE_GATE_COMMAND_UNAVAILABLE');
    expect(codes).not.toContain('XFORGE_GATE_FAILED');
    const unavailable = result.json.diagnostics.find((item: any) => item.code === 'XFORGE_GATE_COMMAND_UNAVAILABLE');
    expect(unavailable.severity).toBe('error');
    /* Names the executable and points at the Gate, which is the thing the reader can change. */
    expect(unavailable.message).toContain('xforge-no-such-executable-anywhere');
    expect(unavailable.message).toContain('Gate');
    expect(unavailable.details).toMatchObject({ gate: 'unit-tests', executable: 'xforge-no-such-executable-anywhere' });

    /* Still blocking: the Evidence says failed, so every transition it guards stays closed. */
    const evidence = JSON.parse(await readFile(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'tests.json'), 'utf8'));
    expect(evidence).toMatchObject({ status: 'failed' });
  });

  it('still reports a command that ran and failed as a Gate failure', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', 'process.exit(1)'];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'all']);
    expect(result.code).toBe(1);
    const codes = result.json.diagnostics.map((item: any) => item.code);
    expect(codes).toContain('XFORGE_GATE_FAILED');
    expect(codes).not.toContain('XFORGE_GATE_COMMAND_UNAVAILABLE');
  });

  it('reuses passed work-package verify Evidence when nothing in the tree moved', async () => {
    const root = await fixture();
    const verify = [process.execPath, '-e', 'process.exit(0)'];
    await applyStageWithVerify(root, verify);
    const evidencePath = path.join(root, ...VERIFY_EVIDENCE);

    const first = await runCli(root, ['check', '--change', 'add-feature']);
    expect(first.code, JSON.stringify(first.json?.diagnostics, null, 2)).toBe(0);
    expect(first.json.data.workPackages[0]).toMatchObject({ status: 'passed', cached: false });
    const evidence = await readFile(evidencePath, 'utf8');

    const second = await runCli(root, ['check', '--change', 'add-feature']);
    expect(second.code).toBe(0);
    expect(second.json.data.workPackages[0]).toMatchObject({ packageId: 'T001', status: 'passed', cached: true });
    /* Byte-identical Evidence is the proof the command did not run again: a real run rewrites
       startedAt, finishedAt, and durationMs. A reused Gate also reports no file change. */
    expect(await readFile(evidencePath, 'utf8')).toBe(evidence);
    expect(second.json.changes.map((item: any) => item.path)).not.toContain(VERIFY_EVIDENCE.join('/'));
  });

  it('re-runs a reusable work-package verify when --force is given', async () => {
    const root = await fixture();
    const verify = [process.execPath, '-e', 'process.exit(0)'];
    await applyStageWithVerify(root, verify);
    const evidencePath = path.join(root, ...VERIFY_EVIDENCE);

    expect((await runCli(root, ['check', '--change', 'add-feature'])).code).toBe(0);
    const evidence = await readFile(evidencePath, 'utf8');

    const forced = await runCli(root, ['check', '--change', 'add-feature', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.json.data.workPackages[0]).toMatchObject({ packageId: 'T001', status: 'passed', cached: false });
    expect(await readFile(evidencePath, 'utf8')).not.toBe(evidence);
    expect(forced.json.changes.map((item: any) => item.path)).toContain(VERIFY_EVIDENCE.join('/'));
  });

  /*
   * Evidence with no attesting `gate.after` event is a transition-unblocking artifact: control-plane
   * gate resolution decides on the Evidence file alone. The failure is injected without any seam in
   * production code — the Gate's own command replaces the Change's audit shard with a directory, so
   * the append that records `gate.after` fails for real, after `gate.before` already succeeded.
   */
  it('restores the previously attested Evidence when gate.after cannot be recorded', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', 'process.exit(0)'];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'unit-tests'])).code).toBe(0);
    const evidencePath = path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'tests.json');
    const attested = await readFile(evidencePath, 'utf8');

    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', "const fs = require('node:fs'); const shard = require('node:path').join('xforge', '.audit', 'changes', 'add-feature.jsonl'); fs.rmSync(shard, { force: true }); fs.mkdirSync(shard, { recursive: true });"];
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const sabotaged = await runCli(root, ['check', '--change', 'add-feature', '--gate', 'unit-tests']);
    expect(sabotaged.code).not.toBe(0);

    /* Restored, not deleted: this Evidence path is stable, so the write was an overwrite of a
       properly attested result that a transient audit failure must not destroy. */
    expect(await readFile(evidencePath, 'utf8')).toBe(attested);
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
