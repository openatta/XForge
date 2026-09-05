import { describe, expect, it } from 'vitest';
import { changeYaml, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

/**
 * Contract governance as a default, and the exact boundary of what defaulting it buys.
 *
 * It shipped as an opt-in template: a `solid-contract` Flow to copy, four Gates to select, a Rule to
 * add. Nothing about that was wrong and nobody adopted it, which is the same outcome as not having
 * written it. What made adoption a project of its own was the four Gates -- every one is
 * `builtin: declared`, so switching them on refuses every Stage exit until the project has recorded
 * a command for a dialect-specific check it never asked for.
 *
 * So the layer splits. What needs no configuration is on by default: a validated interface delta, a
 * baseline no Worker may write, a decision ledger for breaking changes, and a merge at archive. What
 * needs a command stays selected: the four Gates.
 *
 * The honest boundary, which these tests exist to keep honest, is that the default layer governs a
 * *declared* interface change completely and an *undeclared* one not at all. `moduleContract` is the
 * Change's own word for it, and the only thing that compares that word with the diff is
 * `contract-compat`. A coverage report that read `verified` here would be claiming the check the
 * project did not select.
 */
const CHANGE = 'add-feature';
const BASE = `xforge/changes/${CHANGE}`;

async function rules(root: string, change = CHANGE): Promise<any[]> {
  const state = await runCli(root, ['state', '--change', change]);
  return ((state.json.data as any)?.change?.governance?.rules ?? []) as any[];
}

async function artifacts(root: string, change = CHANGE): Promise<any[]> {
  const state = await runCli(root, ['state', '--change', change]);
  return ((state.json.data as any)?.change?.artifacts ?? []) as any[];
}

describe('the contract layer a project gets without configuring anything', () => {
  it('reports the Rule as structurally enforced, and never as verified', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);

    const rule = (await rules(root)).find((item) => item.id === 'interfaces-are-contract-governed');
    expect(rule, 'the Rule ships selected since 0.8.4').toBeTruthy();

    /* Guarded by protected-files at the tool call, structural by the contract-delta validator
       in-process. Both are enforcement; neither is a Gate. */
    expect(rule.coverage).toContain('guarded');
    expect(rule.coverage).toContain('structural');
    /*
     * The claim the project has not bought. `verified` means revision-bound Gate Evidence, and the
     * four Gates that would produce it are `builtin: declared` and unselected -- so saying it here
     * would report a dialect-specific comparison nobody configured as though it had run.
     */
    expect(rule.coverage).not.toContain('verified');
    /* And not `unenforceable` either, which is what a Rule naming only absent Gates would be. This
       one names a validator the Flow actually runs, so the claim resolves. */
    expect(rule.coverage).not.toContain('unenforceable');
    expect(rule.enforceableRefs).toContain('contract-delta');
  });

  it('owes no interface delta from a Change that declares it moves no interface', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);

    /* `createCompleteSolidChange` writes no `moduleContract`, which is the ordinary case: nine
       Changes in ten move no interface between modules. */
    const delta = (await artifacts(root)).find((item) => item.id === 'contract-delta');
    expect(delta, 'the Flow declares the Artifact for every Change').toBeTruthy();
    /*
     * Owed is the question, not declared. An Artifact this Change does not owe is complete: holding
     * its Stage open until it writes a document saying "nothing changed" is a required turn spent
     * asserting nothing, which is the friction that kept the opt-in version unadopted.
     */
    expect(delta.status).toBe('done');
    expect(delta.outputPaths).toEqual([]);
  });

  it('owes one from a Change that declares it does', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `${BASE}/change.yaml`, changeYaml('solid', {
      classification: { risk: 'medium', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
    }));

    const delta = (await artifacts(root)).find((item) => item.id === 'contract-delta');
    expect(delta.status).not.toBe('done');
    expect(delta.outputPaths).toEqual([]);
  });

  /*
   * Both of these have to stand at the Check Stage to mean anything. An exit condition is evaluated
   * for the Stage a Change is actually in, so asserting from `propose` reports an empty `blockedBy`
   * whatever the condition says -- which passes for the wrong reason in one direction and cannot
   * fail in the other.
   */
  async function blockingCheckExit(root: string): Promise<string[]> {
    await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);
    const moved = await runCli(root, ['transition', '--change', CHANGE, '--to', 'check']);
    expect(moved.code, JSON.stringify(moved.json?.diagnostics)).toBe(0);
    await runCli(root, ['check', '--change', CHANGE]);
    const state = await runCli(root, ['state', '--change', CHANGE]);
    const change = (state.json.data as any)?.change;
    expect(change?.stage).toBe('check');
    /* What holds the Change in Check, read off the transition it is trying to take. An exit
       condition belongs to a transition, not to the Stage as a whole. */
    const onward = (change?.governance?.readyTransitions ?? []).find((entry: any) => entry.to === 'apply');
    expect(onward, JSON.stringify(change?.governance?.readyTransitions)).toBeTruthy();
    return (onward.blockedBy ?? []) as string[];
  }

  it('does not block a no-interface Change on the decision ledger it has no decision for', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);

    /* The exit condition is declared on the Check Stage for every Change and owed by the ones that
       declared an interface change. A Change that did not is not blocked by an absent ledger --
       reported as nothing at all rather than as a satisfied condition, because it was never asked. */
    const blocked = await blockingCheckExit(root);
    expect(blocked.filter((item) => item.startsWith('condition:contractDecisions'))).toEqual([]);
  });

  it('blocks a declared interface change until somebody has decided it', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, `${BASE}/change.yaml`, changeYaml('solid', {
      classification: { risk: 'medium', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
    }));
    /* The delta this Change now owes, so the only thing left unanswered is the decision ledger. */
    await write(root, `${BASE}/contracts/http.md`, [
      '## ADDED Contract Elements', '',
      '### Element: openapi:paths./orders.post', '',
      '- module: api',
      '- breaking: false', '',
      '## MODIFIED Contract Elements', '', '(none)', '',
      '## REMOVED Contract Elements', '', '(none)', '',
      '## Breaking Changes', '', '(none)', '',
      '## Consumer Impact', '', 'None: the operation is new.', '',
    ].join('\n'));

    const blocked = await blockingCheckExit(root);
    expect(blocked.some((item) => item.startsWith('condition:contractDecisions')),
      JSON.stringify(blocked)).toBe(true);
  });

  it('lets Solid and Major carry an interface change, and still refuses Quick', async () => {
    const root = await fixture();
    /*
     * Quick has no Stage that declares an interface delta, so a Change that moves one has nowhere to
     * record it -- the refusal is structural rather than a policy preference. Major had to move with
     * Solid for the opposite reason: a Flow of higher assurance that refused an interface change
     * would turn escalation into a dead end at the exact point escalating was right.
     */
    await write(root, 'xforge/changes/quick-contract/change.yaml', changeYaml('quick', {
      classification: { risk: 'low', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
    }));
    await write(root, 'xforge/changes/quick-contract/proposal.md', '## Why\nTest\n\n## Flow choice\nquick\n');
    const refused = await runCli(root, ['check', '--change', 'quick-contract', '--gate', 'structure']);
    const codes = (refused.json.diagnostics as any[]).map((item) => item.code);
    expect(codes.some((code: string) => code === 'XFORGE_FLOW_TOO_WEAK' || code === 'XFORGE_FLOW_INELIGIBLE'),
      JSON.stringify(codes)).toBe(true);
  });
});
