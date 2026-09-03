import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeYaml, clearVerification, fixture, runCli, updateYaml, write } from '../helpers.js';

/**
 * When an undeclared Gate actually bites, per Gate and per Flow.
 *
 * The message names the Flow in its first clause and then asserted, for every Flow and every Gate,
 * that the refusal comes "after an approval has been collected". It is false for most of them:
 * Quick runs `unit-tests` at verify and collects its only approval at archive, after it; a
 * contract-governed Flow runs `contract-lint` at design, two Stages before `planning-solid`. Two
 * separate hand-driven runs met the wrong half of it. A reader who checks one claim in a message
 * and finds it untrue stops checking the rest, and the rest is the part that matters — the warning
 * against answering the Gate with whatever command happens to exist.
 */
describe('when an undeclared Gate will refuse', () => {
  async function clause(root: string, changeId: string, gate: string): Promise<string> {
    const result = await runCli(root, ['state', '--change', changeId]);
    const found = (result.json.diagnostics as any[])
      .filter((item) => item.code === 'XFORGE_VERIFICATION_GATE_UNDECLARED')
      .find((item) => item.message.includes(`Gate ${gate},`));
    expect(found, `no undeclared notice for ${gate}: ${JSON.stringify((result.json.diagnostics as any[]).map((i) => i.code))}`).toBeDefined();
    return /which on this Flow is[^.]*\./.exec(found.message)?.[0] ?? '';
  }

  it('names the Stage, and says no approval precedes it when none does', async () => {
    const root = await fixture();
    await clearVerification(root);
    await write(root, 'xforge/changes/p/change.yaml', changeYaml('quick', {
      classification: { risk: 'low', security: false, privacy: false, publicApi: false, dataMigration: false },
    }));
    /* Quick runs unit-tests at verify and collects quick-close at archive, after it. */
    expect(await clause(root, 'p', 'unit-tests')).toBe('which on this Flow is the verify Stage, before any approval is collected.');
  });

  it('says an approval precedes it when one does', async () => {
    const root = await fixture();
    await clearVerification(root);
    await write(root, 'xforge/changes/p/change.yaml', changeYaml('solid'));
    /* Solid collects planning-solid at the check exit, which is before verify. */
    expect(await clause(root, 'p', 'unit-tests')).toBe('which on this Flow is the verify Stage, after an approval has already been collected.');
  });

  it('is right about a Gate that runs before any approval on a contract-governed Flow', async () => {
    const root = await fixture();
    const template = await readFile(path.join(root, 'xforge', 'scaffold', 'flows', 'solid-contract.yaml'), 'utf8');
    await write(root, 'xforge/flows/solid-contract.yaml', template);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest: any) => {
      manifest.scaffold.flows = [...manifest.scaffold.flows, 'solid-contract'];
      manifest.scaffold.gates = [...manifest.scaffold.gates, 'contract-lint', 'contract-compat', 'contract-drift', 'module-boundaries'];
    });
    await runCli(root, ['install']);
    await write(root, 'xforge/changes/p/change.yaml', changeYaml('solid', {
      flow: 'solid-contract',
      classification: { risk: 'medium', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
    }));
    /* contract-lint runs at design; planning-solid is collected two Stages later, at the check exit. */
    expect(await clause(root, 'p', 'contract-lint')).toBe('which on this Flow is the design Stage, before any approval is collected.');
  });

  /*
   * The command in the field, not only in the sentence.
   *
   * This diagnostic has always named the declare call in prose, and prose is where it stayed: a
   * reader had to parse an argv back out of an English paragraph, which is the exact job
   * `Diagnostic.remedy` was added to end. A measured `solid` run met this at propose and carried it
   * unanswered to verify, five Stages later.
   *
   * `<program>` stays a placeholder while the message shows `["cargo","test"]`. The message can
   * afford an illustration because its next sentence says not to copy one; a field meant to be
   * executed cannot, and this Gate exists precisely because a plausible test command that asserts
   * nothing is the failure being prevented.
   */
  it('carries the declare command as an argv, not only inside the message', async () => {
    const root = await fixture();
    await clearVerification(root);
    await write(root, 'xforge/changes/p/change.yaml', changeYaml('solid'));
    const result = await runCli(root, ['state', '--change', 'p']);
    const found = (result.json.diagnostics as any[])
      .filter((item) => item.code === 'XFORGE_VERIFICATION_GATE_UNDECLARED')
      .find((item) => item.message.includes('Gate unit-tests,'));
    expect(found).toBeDefined();
    expect(found.remedy?.commands).toEqual([
      ['xforge', 'verification', 'declare', '--gate-name', 'unit-tests', '--command', '["<program>","<arg>"]', '--by', '<the person who answered>'],
    ]);
  });
});
