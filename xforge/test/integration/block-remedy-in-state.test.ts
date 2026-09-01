import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

/**
 * The route out of a blocked transition, said where the block is read.
 *
 * `blockRemedy` is called from `transition` and `archive` — you get the remedy when you try the
 * thing. But `XFORGE.md` tells an Agent to treat `state` as the authoritative account of what to do
 * next, and `state` carried the block as a bare token and nothing else. `xforge explain` does not
 * take those tokens either; they are not diagnostic codes.
 *
 * A hand-driven Major run met `condition:materialQuestions:stale-Q1` in exactly that form and said
 * the message alone was not enough to work out what had gone stale or why — it knew only because
 * `xforge-clarify` carries a bullet about it, and reported that someone working from CLI output
 * alone "would very plausibly have bumped the timestamp", which is the single move that field
 * exists to prevent. The same run met XFORGE_GATE_EVIDENCE_STALE, which names the Gate, the binding
 * and the exact command, and called it sufficient without the Skill. Same mechanism, two ledgers,
 * and the difference was entirely in what the CLI said.
 */
describe('a blocked transition names its route out', () => {
  const CHANGE = 'add-feature';

  it('carries the remedy in state, not only when the transition is attempted', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'check']);
    /* An unresolved blocker in the findings ledger blocks the Check exit. */
    await write(root, `xforge/changes/${CHANGE}/evidence/check-findings.yaml`, [
      'findings:',
      '  - id: CF-001',
      '    severity: blocker',
      '    summary: Something a person must answer.',
      '    refs: [design.md]',
      '    status: open',
      '',
    ].join('\n'));

    const read = await runCli(root, ['state', '--change', CHANGE]);
    const blocked = ((read.json.data as any).change.governance.readyTransitions as any[])
      .filter((item) => !item.ready && item.blockedBy.length > 0);
    expect(blocked.length, 'nothing was blocked, so there is no remedy to look for').toBeGreaterThan(0);

    /* Whatever the block is, reading state must say what to do about it — not just name a token. */
    const remedies = (read.json.diagnostics as any[]).filter((item) => item.code.endsWith('_REMEDY'));
    expect(remedies.length, JSON.stringify({
      blockedBy: blocked.map((item) => item.blockedBy),
      codes: (read.json.diagnostics as any[]).map((item) => item.code),
    })).toBeGreaterThan(0);
    expect(remedies[0].severity).toBe('info');
  });

  it('says nothing when no transition is blocked', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    const read = await runCli(root, ['state', '--change', CHANGE]);
    const ready = ((read.json.data as any).change.governance.readyTransitions as any[]).find((item) => item.to === 'design');
    expect(ready?.ready, 'the fixture was supposed to be able to reach design').toBe(true);
    expect((read.json.diagnostics as any[]).filter((item) => item.code.endsWith('_REMEDY'))).toEqual([]);
  });
});
