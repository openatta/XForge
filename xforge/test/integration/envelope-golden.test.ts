import { describe, expect, it } from 'vitest';
import { renderEnvelope } from '../envelope-normalise.js';
import { golden } from '../golden.js';
import { CHECK_FINDINGS_PATH } from '../../src/core/check-findings.js';
import {
  advanceSolidToApply, createCompleteSolidChange, fixture, runCli, write, writeVerificationReceipt,
} from '../helpers.js';

const CHANGE = 'add-feature';

/**
 * The complete envelope of every command, recorded for a success and for a refusal.
 *
 * The existing suite asserts fields it names — `result.json.data.gates`, one diagnostic code — so
 * everything it does not name is free to change: a field can be dropped, a diagnostic can move to a
 * different position, `nextActions` can empty out, and nothing fails. Three of the defects fixed
 * during this work were exactly that shape, including an approval command that was present in
 * `nextActions` and unreachable in practice.
 *
 * Recording the whole envelope makes the *shape* the assertion. During the structural refactor that
 * is the second behavioural signature after the projection golden; afterwards it is the standing
 * answer to "what does this command actually return".
 *
 * Volatile fields are normalised (`envelope-normalise.ts`) rather than removed, so their presence
 * and position stay covered even though their values cannot be.
 */
describe('envelope golden', () => {
  /** One Change parked at Verify with Gate Evidence present — the widest state a command can meet. */
  async function atVerify(): Promise<string> {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `xforge/changes/${CHANGE}/${CHECK_FINDINGS_PATH}`, [
      'findings:',
      '  - id: CHK-001',
      '    severity: warning',
      '    summary: Should the retry budget be configurable?',
      '    refs: [proposal.md]',
    ].join('\n') + '\n');
    await advanceSolidToApply(root, CHANGE);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'verify']);
    await runCli(root, ['check', '--change', CHANGE]);
    await writeVerificationReceipt(root, CHANGE);
    return root;
  }

  /**
   * Read-only or `--dry-run` only, on purpose.
   *
   * A golden that mutated the fixture would record the first scenario's side effects into the
   * second's output, which makes every row after the first depend on the order they run in.
   */
  const scenarios: Array<{ name: string; argv: string[] }> = [
    { name: 'help', argv: ['help'] },
    { name: 'help-check', argv: ['help', 'check'] },
    { name: 'version', argv: ['version'] },
    { name: 'state', argv: ['state'] },
    { name: 'state-change', argv: ['state', '--change', CHANGE] },
    { name: 'state-kind-gates', argv: ['state', '--kind', 'gates'] },
    { name: 'check-change', argv: ['check', '--change', CHANGE] },
    { name: 'check-stage-verify', argv: ['check', '--change', CHANGE, '--stage', 'verify'] },
    { name: 'doctor', argv: ['doctor'] },
    { name: 'audit-status', argv: ['audit', 'status', '--change', CHANGE] },
    { name: 'audit-verify', argv: ['audit', 'verify', '--change', CHANGE] },
    { name: 'transition-dry-run', argv: ['transition', '--change', CHANGE, '--to', 'ready-to-archive', '--dry-run'] },
    { name: 'archive-dry-run', argv: ['archive', '--change', CHANGE, '--dry-run'] },
    { name: 'verification-draft-receipt', argv: ['verification', 'draft-receipt', '--change', CHANGE] },
    /* `finalize` is the command that writes the receipt, so its `changes` entry is the part of its
       envelope worth pinning — under `--dry-run`, where recording it costs the fixture nothing. */
    { name: 'verification-finalize-dry-run', argv: ['verification', 'finalize', '--change', CHANGE, '--status', 'passed', '--by', 'owner@example.test', '--dry-run'] },
    { name: 'install-dry-run', argv: ['install', '--dry-run'] },
    { name: 'upgrade-scaffold-dry-run', argv: ['upgrade-scaffold', '--dry-run'] },
    /* Refusals, which are the half the suite covers least: 165 of 320 codes are asserted nowhere. */
    /* `archive` inherits the case `brief` used to carry: a command that cannot act without a Change,
       refusing before it does anything. */
    { name: 'error-change-required', argv: ['archive'] },
    /* And an option refused for the command it was not written for, which `--compact` used to
       demonstrate before it left with the brief. */
    { name: 'error-option-not-allowed', argv: ['audit', 'verify', '--output', 'somewhere.json'] },
    { name: 'error-unknown-command', argv: ['frobnicate'] },
    { name: 'error-unknown-option', argv: ['state', '--frobnicate', 'x'] },
    { name: 'error-unknown-change', argv: ['state', '--change', 'no-such-change'] },
    { name: 'error-unknown-gate', argv: ['check', '--change', CHANGE, '--gate', 'no-such-gate'] },
    { name: 'error-findings-arguments', argv: ['findings', 'resolve', '--change', CHANGE] },
    { name: 'error-field-not-found', argv: ['state', '--change', CHANGE, '--field', 'nope.nope'] },
  ];

  it.each(scenarios)('records the envelope for $name', async ({ name, argv }) => {
    const root = await atVerify();
    const result = await runCli(root, argv);
    const recorded = [
      `$ xforge ${argv.join(' ')}`,
      `exit: ${result.code}`,
      '',
      renderEnvelope(result.stdout, { root }),
    ].join('\n');
    const { actual, expected } = await golden(`envelope/${name}.txt`, recorded);
    expect(actual).toBe(expected);
  });

  it('records the readable form of the commands that render one', async () => {
    const root = await atVerify();
    for (const [name, argv] of [
      ['state-text', ['state', '--change', CHANGE, '--text']],
      ['check-text', ['check', '--change', CHANGE, '--text']],
    ] as Array<[string, string[]]>) {
      const result = await runCli(root, argv);
      const { actual, expected } = await golden(`envelope/${name}.txt`, renderEnvelope(result.stdout, { root }));
      expect(actual, name).toBe(expected);
    }
  });

  it('produces the same envelope twice for the same scenario', async () => {
    /* The property the goldens above rest on. Asserted rather than assumed: a field that varies
       between runs would otherwise be discovered as an intermittent failure weeks later, by
       somebody who did not add it. */
    const first = await atVerify();
    const second = await atVerify();
    for (const argv of [['state', '--change', CHANGE], ['check', '--change', CHANGE], ['audit', 'verify', '--change', CHANGE]]) {
      const a = renderEnvelope((await runCli(first, argv)).stdout, { root: first });
      const b = renderEnvelope((await runCli(second, argv)).stdout, { root: second });
      expect(a, argv.join(' ')).toBe(b);
    }
  });
});
