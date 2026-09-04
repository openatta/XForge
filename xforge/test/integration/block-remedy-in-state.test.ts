import { describe, expect, it } from 'vitest';
import { changeYaml, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

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

  /*
   * Narrowing the reply must not strip the thing the reader was going to act on.
   *
   * `--field` exists so a caller does not carry the whole envelope for the rest of the session, and
   * `readyTransitions` is what a Stage asks for when deciding whether it may leave. It answered
   * `{to, ready, blockedBy}` and nothing else, so a measured run read "transition to propose is
   * ready", had no command to run, and spent a turn on `xforge --help` -- 10,748 characters -- to
   * find the syntax of the call it had just been told was available. The narrow reply cost more
   * than the wide one it replaced.
   */
  it('carries each ready transition\'s own command, so narrowing to them does not cost a help lookup', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);

    const narrowed = await runCli(root, ['state', '--change', CHANGE, '--field', 'change.governance.readyTransitions']);
    /* One `--field` prints that value and nothing else, so the reply is the list itself; several
       come back as an object keyed by the paths asked for. */
    const transitions = narrowed.json as unknown as Array<{ to: string; command: string[] }>;
    expect(Array.isArray(transitions), JSON.stringify(narrowed.json).slice(0, 400)).toBe(true);
    expect(transitions.length).toBeGreaterThan(0);
    for (const entry of transitions) {
      expect(entry.command, `no command on transition to ${entry.to}`).toEqual(
        ['xforge', 'transition', '--change', CHANGE, '--to', entry.to],
      );
    }
  });

  /*
   * The one-call form, where running the Gates is the whole remaining job.
   *
   * `advance` runs this Stage's Gates and takes the Transition if none refuses; the CLI calls it "a
   * call-count optimisation and nothing else" and `xforge-apply` tells an Agent to leave with it.
   * `nextActions` -- which is where the Skills say to take a command from -- never named it, so a
   * Stage blocked only by Gates it could run was handed N `check` calls plus a `transition` that
   * would refuse until those N had happened. Two commands for one act, and the product named the
   * one that fails first.
   */
  it('offers advance when only runnable Gates remain, in place of N checks and a transition', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    /* Artifacts are all present, so what is left blocking the exit is this Stage's own Gates. */
    const state = await runCli(root, ['state', '--change', CHANGE, '--field', 'nextActions']);
    const actions = state.json as unknown as Array<Record<string, any>>;
    const advance = actions.filter((item) => item.action === 'advance');
    const blockedTransitions = actions.filter((item) => item.action === 'transition' && item.status === 'blocked');

    expect(advance.length, JSON.stringify(actions.map((a) => [a.action, a.id, a.status, a.blockedBy]))).toBeGreaterThan(0);
    for (const item of advance) {
      expect(item.status).toBe('ready');
      expect(item.command).toEqual(['xforge', 'advance', '--change', CHANGE, '--to', item.id]);
      /* It replaces the pair, so it must claim only what it can finish: every blocker on the
         matching transition has to be a Gate this Stage can actually run. */
      const paired = blockedTransitions.find((entry) => entry.id === item.id);
      for (const block of paired?.blockedBy ?? []) expect(block, `advance offered past ${block}`).toMatch(/^gate:.+:(missing|stale)$/);
    }
  });

  it('withholds advance when an approval or artifact is what stands in the way', async () => {
    const root = await fixture();
    /* Nothing written: the exit is blocked by missing Artifacts, which no Gate run can produce. */
    await write(root, `xforge/changes/${CHANGE}/change.yaml`, changeYaml('solid'));
    const state = await runCli(root, ['state', '--change', CHANGE, '--field', 'nextActions']);
    const actions = state.json as unknown as Array<Record<string, any>>;
    expect(actions.filter((item) => item.action === 'advance')).toEqual([]);
  });
});
