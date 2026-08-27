import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { project } from '../project-builder.js';
import { runCli, updateYaml } from '../helpers.js';

/**
 * Three constraints that were real, enforced, and stated nowhere a reader would look.
 *
 * A field report on a Rust project ran three governed Changes end to end without a single trust
 * failure and summarised the friction as discoverability: "机制都对，但要让 agent 和人类审批人少花推理"
 * — the mechanisms are right, the reasoning they demand of a reader is not. Each case below is one
 * fact the product already knew and only expressed somewhere the reader was not.
 */
describe('constraints the CLI now states', () => {
  it('says whether pending remote delivery is anything to act on', async () => {
    const built = await project().flow('solid').atStage('apply').build();
    const result = await runCli(built.root, ['state', '--change', built.change, '--text']);

    /*
     * A live run read `remotePending: 50`, stopped, and asked whether it had to be dealt with. The
     * name implies unfinished delivery; whether that matters is decided by a policy this line does
     * not show. The shipped default makes it mean nothing at all, so the reader was choosing between
     * chasing a non-problem and ignoring a real one with no basis for either.
     */
    expect(result.code).toBe(0);
    /* Either shape is correct — what matters is that the count no longer stands unexplained. */
    expect(result.stdout).toMatch(/remote delivery (none pending|\d+ pending \((REQUIRED|not required)[^)]*\))/);
    expect(result.stdout).not.toMatch(/\d+ awaiting remote delivery/);

    const json = await runCli(built.root, ['state', '--change', built.change]);
    expect(json.json.data.change.governance.audit.remoteRequired).toBe(false);
  }, 600_000);

  it('names an unanswered required Gate while there is still time to answer it', async () => {
    const built = await project().flow('solid').atStage('propose').build();
    const root = built.root;
    /* `unit-tests` shipped as a `declared` Gate: it runs whatever the project declares and refuses
       when nothing is declared. That refusal is correct and arrives at the Stage that runs it —
       on a Major Flow, after a human approval has already been spent. */
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.builtin = 'declared';
      gate.spec.required = true;
      delete gate.spec.command;
    });
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { delete manifest.verification; });
    expect((await runCli(root, ['install'])).code).toBe(0);

    const state = await runCli(root, ['state', '--change', built.change]);
    const notice = state.json.diagnostics.find((item: any) => item.code === 'XFORGE_VERIFICATION_GATE_UNDECLARED');
    expect(notice, JSON.stringify(state.json.diagnostics.map((item: any) => item.code))).toBeDefined();
    expect(notice.message).toContain('unit-tests');
    /* The command, not just the complaint. */
    expect(notice.message).toContain('xforge verification declare --gate-name unit-tests');
    /*
     * `info`, deliberately. `check` counts warnings when deciding whether a Stage may close, so
     * raising this would make an unanswered question block Stages it has nothing to do with.
     */
    expect(notice.severity).toBe('info');

    /* And it is self-clearing: answering it once removes it for good. */
    expect((await runCli(root, [
      'verification', 'declare', '--gate-name', 'unit-tests',
      '--command', `["${process.execPath}","-e","process.exit(0)"]`, '--by', 'owner@example.test',
    ])).code).toBe(0);
    const answered = await runCli(root, ['state', '--change', built.change]);
    expect(answered.json.diagnostics.filter((item: any) => item.code === 'XFORGE_VERIFICATION_GATE_UNDECLARED')).toEqual([]);
  }, 600_000);

  it('says a Gate passed against content that has since moved, and gives the order that avoids it', async () => {
    const built = await project().flow('solid').atStage('check').build();
    /* The Gates of this Stage, run and passing. */
    expect((await runCli(built.root, ['check', '--change', built.change])).code).toBe(0);

    /*
     * Then a declared Artifact is written, which is the ordinary next thing to do and which moves
     * the content revision — staling every Gate that just passed. The constraint lived only in the
     * Skill prose, and a live run reconstructed it from a boolean in `state.mandatoryGateEvidence`
     * after `structure` turned out to be bound to a gitHead 43 source files old.
     */
    const proposal = path.join(built.root, 'xforge', 'changes', built.change, 'proposal.md');
    await writeFile(proposal, `${await readFile(proposal, 'utf8')}\nA sentence added after the Gates ran.\n`);

    /* One Gate re-run, which is what an author does after an edit. The others stay bound to the
       revision that existed before the edit — the state the notice is about. */
    const after = await runCli(built.root, ['check', '--change', built.change, '--gate', 'structure']);
    const stale = after.json.diagnostics.find((item: any) => item.code === 'XFORGE_GATE_EVIDENCE_STALE');
    expect(stale, JSON.stringify(after.json.diagnostics.map((item: any) => item.code))).toBeDefined();
    expect(stale.severity).toBe('warning');
    /* The ordering rule itself, which is the part that was only ever in the Skill. */
    expect(stale.message).toContain('draft-receipt');
    expect(stale.message).toContain('stales it');

    /*
     * And it is counted as the Change-scoped warning it is. The advisory filter required a trailing
     * slash on the Change path, so a diagnostic pointed at `changes/<id>` — the convention this very
     * notice uses — was classified project-level and never reached
     * `XFORGE_CHECK_PASSED_WITH_WARNINGS`. The one notice whose job is to stop a warning being
     * walked past could not see the most Change-specific warning in the run.
     */
    const counted = after.json.diagnostics.find((item: any) => item.code === 'XFORGE_CHECK_PASSED_WITH_WARNINGS');
    expect(counted, JSON.stringify(after.json.diagnostics.map((item: any) => item.code))).toBeDefined();
    expect(counted.message).toContain('XFORGE_GATE_EVIDENCE_STALE');
  }, 600_000);
});
