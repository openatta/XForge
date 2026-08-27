import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { project } from '../project-builder.js';
import { approveCurrentRevision, runCli, write, writeVerificationReceipt } from '../helpers.js';

async function git(root: string, args: string[]): Promise<void> {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], { shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (status) => resolve(status ?? 1));
  });
  expect(code, args.join(' ')).toBe(0);
}

async function initializeGit(root: string): Promise<void> {
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'XForge Test']);
  await git(root, ['config', 'user.email', 'test@example.test']);
  await commit(root, 'base');
}

async function commit(root: string, message: string): Promise<void> {
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', message]);
}

/** The item the brief reports as `awaitingDecision`: open, and naming no Stage to send anything back to. */
const AWAITING = [
  '  - id: CHK-010',
  '    severity: warning',
  '    summary: Accept the single-instance deployment shape, or name the signal that forces a move?',
  '    refs: [design.md]',
  '    status: open',
].join('\n');

/** The command as the brief printed it, with only the two placeholders a person owns filled in. */
function asArgv(command: string, answer: string, by: string): string[] {
  return (command.match(/'[^']*'|\S+/g) ?? [])
    .map((token) => token.replace(/^'|'$/g, ''))
    .map((token) => (token === '<what you decided>' ? answer : token === '<you>' ? by : token))
    .slice(1);
}

/**
 * What the brief leaves an approver able to *do* about the two things it reports and nothing else
 * routes: an item somebody must answer, and Gate Evidence older than the code.
 */
describe('what the decision brief leaves an approver able to act on', () => {
  /*
   * An awaiting item used to state the outcome — record the answer, set the entry to
   * `status: resolved` — and, once the command existed, named it with `<id>` and `<finding-id>`
   * still in it. A live run read that at `ready-to-archive` with three such entries in front of it
   * and archived with all three open. Being told what must become true is not being told what to
   * run: the reader has to match template to ids at the one moment they are trying to finish, so
   * the command is on the entry, filled in, in both forms.
   */
  it('names the command that clears each awaiting item, filled in, in the JSON and in the text', async () => {
    const built = await project().flow('solid').findings([AWAITING]).atStage('check').build();

    const result = await runCli(built.root, ['brief', '--change', built.change]);
    const awaiting = result.json.data.decision.awaitingDecision;
    expect(awaiting.map((entry: any) => entry.id)).toEqual(['CHK-010']);
    expect(awaiting[0].command).toContain(`xforge findings resolve --change ${built.change} --id CHK-010`);

    /* The text form is what the Skills tell an Agent to relay, so a command that reaches only the
       JSON reaches nobody who signs. */
    const text = await runCli(built.root, ['brief', '--change', built.change, '--text']);
    expect(text.stdout).toContain('Awaiting your answer: CHK-010');
    expect(text.stdout).toContain(`xforge findings resolve --change ${built.change} --id CHK-010`);

    /* Run exactly what was printed. A command a brief composes but the CLI would refuse is worse
       than the prose it replaced, because it costs the reader the attempt before they find out. */
    const resolve = await runCli(built.root, asArgv(
      awaiting[0].command,
      'Accepted. A second instance is the signal, and nothing before it is.',
      'owner@example.test',
    ));
    expect(resolve.code, JSON.stringify(resolve.json?.diagnostics)).toBe(0);
    const after = await runCli(built.root, ['brief', '--change', built.change]);
    expect(after.json.data.decision.awaitingDecision).toEqual([]);
  }, 240_000);

  /*
   * `staleAgainstCode` was a flat list, and at `ready-to-archive` a real run read
   * `["check-findings", "constitution-check"]` against 43 source files moved since they ran. Both
   * are Check-Stage Gates and the code moved during Apply, which is what Apply is; nothing at that
   * point asks a closed Stage's Evidence to bind the current tree. Undifferentiated, that reads as
   * an audit defect, and the approver either investigates every archive or learns to wave the list
   * through — while the Gates archive actually turns on sit in the same list, indistinguishable.
   */
  it('separates Evidence a closed Stage left behind from Evidence this position still turns on', async () => {
    const built = await project().flow('solid').atStage('check').build();
    const { root, change } = built;
    await initializeGit(root);

    /* The Check Stage's Gates, run against the tree as it stood before any implementation. */
    await runCli(root, ['check', '--change', change]);
    await write(root, 'src/order/refund.ts', 'export const refund = true;\n');
    await commit(root, 'implement the refund path');

    await approveCurrentRevision(root, change, 'apply', 'planning-solid');
    await runCli(root, ['transition', '--change', change, '--to', 'apply']);
    await runCli(root, ['transition', '--change', change, '--to', 'verify']);
    await runCli(root, ['check', '--change', change]);
    await writeVerificationReceipt(root, change);
    /* One more commit after the verify Gates ran, so the same brief carries both cases: Evidence a
       closed Stage left behind, and Evidence the archive itself requires to speak for this tree. */
    await write(root, 'src/order/refund.ts', 'export const refund = false;\n');
    await commit(root, 'change the refund path again');
    await runCli(root, ['transition', '--change', change, '--to', 'ready-to-archive']);
    await approveCurrentRevision(root, change, 'archive', 'closing-solid');

    const brief = await runCli(root, ['brief', '--change', change]);
    const provenance = brief.json.data.computed.find((entry: any) => entry.id === 'computed.gates.provenance').value;

    /* Unchanged, and deliberately still the whole set: it answers "which Gates exercised code that
       has since moved", and that answer must not depend on where the Change stands. */
    expect(provenance.staleAgainstCode).toEqual(expect.arrayContaining(['check-findings', 'constitution-check', 'unit-tests']));

    const groups: any[] = provenance.staleByStage;
    const check = groups.find((group) => group.stage === 'check');
    expect(check.gates).toEqual(expect.arrayContaining(['check-findings', 'constitution-check']));
    expect(check.expected).toBe(true);
    expect(check.why).toContain('check');

    /* The other half, and the reason this is not simply "an earlier Stage is always fine": archive
       requires the verify Stage's Gates to speak for the tree being archived, so their staleness is
       the question rather than the background. */
    const verify = groups.find((group) => group.stage === 'verify');
    expect(verify.gates).toEqual(expect.arrayContaining(['unit-tests']));
    expect(verify.expected).toBe(false);
    expect(check.gates).not.toContain('unit-tests');

    /*
     * And it reaches the reader it was written for. The grouping lives in a `computed` item, which
     * the text form renders generically — as one line of JSON, leaving the reassurance and the
     * warning equally unreadable in the only form an approver sees.
     */
    const text = await runCli(root, ['brief', '--change', change, '--text']);
    expect(text.stdout).toContain('Expected — check:');
    expect(text.stdout).toContain('Look at this — verify:');
    expect(text.stdout).not.toContain('"staleByStage":');

    /* Presentation only. What archive accepts is Evidence bound to the current content revision,
       and committing source moves neither that nor this Change's readiness. */
    const dryRun = await runCli(root, ['archive', '--change', change, '--dry-run']);
    expect(dryRun.code, JSON.stringify(dryRun.json?.diagnostics)).toBe(0);
  }, 240_000);
});
