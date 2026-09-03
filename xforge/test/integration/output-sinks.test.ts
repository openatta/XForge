import { describe, expect, it } from 'vitest';
import { project } from '../project-builder.js';
import { runCli, write } from '../helpers.js';

/**
 * Everything a check collects has to reach somebody.
 *
 * The defect this is written against is not a wrong answer; it is a right answer that stopped.
 * `evaluateCheckFindings` and `evaluateConstitutionCheck` both built a `warnings` list, the Gate
 * runner read `problems` and dropped the rest, and so the disclosure that a `resolvedBy` had been
 * accepted with nothing to check it against — described in the module comment, described in the
 * `xforge-check` Skill, relied on by neither — had never once been printed. Line coverage was 100%:
 * the code that produced the warning ran every time. What was missing was the sink.
 *
 * Coverage cannot see this, and neither can a test that asserts on a returned object: the value
 * exists, it is correct, and it goes nowhere. The only assertion that catches it goes all the way to
 * what a person reads.
 */
describe('output sinks', () => {
  it('prints a findings-ledger warning through the Gate that evaluated it', async () => {
    const built = await project()
      .flow('solid')
      /*
       * A non-blocker closed with no attribution. Only a blocker's `resolvedBy` fails this Gate, so
       * this passes — and the whole question is whether a passing Gate says what it noticed.
       */
      .findings(['  - id: CHK-001', '    severity: warning', '    summary: Should the retry budget be configurable?', '    refs: [proposal.md]', '    status: resolved'])
      .atStage('check')
      .build();

    const result = await runCli(built.root, ['check', '--change', built.change, '--gate', 'check-findings']);
    const evidence = result.json.data.gates[0].evidence;
    expect(evidence.status).toBe('passed');
    /* Read from the summary `check` returns by default. A passing Gate's transcript is trimmed to
       the lines that carry meaning a status does not — the first, and every warning — because a Gate
       that passes while warning is exactly the case a bare `passed` hides. */
    expect(evidence.outputLines.join('\n')).toContain('names no resolvedBy');
  }, 300_000);

  it('prints a Constitution-ledger warning through the Gate that evaluated it', async () => {
    const built = await project().flow('solid').atStage('design').build();
    const ledger = `xforge/changes/${built.change}/evidence/constitution-check.yaml`;
    const source = await runCli(built.root, ['state', '--change', built.change]);
    expect(source.code).toBe(0);
    /* A principle citing something the project cannot locate: a quality problem, not a failure. */
    await write(built.root, ledger, (await readLedger(built.root, ledger)).replace('references: [proposal.md]', 'references: [nowhere.md]'));

    const result = await runCli(built.root, ['check', '--change', built.change, '--gate', 'constitution-check']);
    const evidence = result.json.data.gates[0].evidence;
    /* Whichever verdict the ledger earns, the observation must be somewhere a reader sees it. */
    expect(`${evidence.stdout}${evidence.stderr}`).toContain('nowhere.md');
  }, 300_000);

  it('reaches a reader with every source reconciliation could not read', async () => {
    const built = await project().flow('solid').atStage('check').build();
    /*
     * A ledger that parses and carries no list. Chosen over deleting a file because a missing
     * directory is not unreadable — `fg` returns nothing for one, zero Requirements are reported,
     * and no `unavailable` entry is produced at all. The first version of this test asserted against
     * that and passed its own loop vacuously, which is the failure mode a test about missing output
     * is most able to have.
     */
    await write(built.root, `xforge/changes/${built.change}/evidence/check-findings.yaml`, 'notfindings: []\n');

    const json = await runCli(built.root, ['check', '--change', built.change, '--gate', 'structure']);
    const text = await runCli(built.root, ['check', '--change', built.change, '--gate', 'structure', '--text']);
    /* A source the reconciliation rules could not read is a warning naming the section and the code,
       and it has to reach the readable form as well as the envelope. */
    const unreadable = (json.json.diagnostics as any[]).filter((item) => item.severity === 'warning' && /UNREADABLE/.test(item.code));
    expect(unreadable.length, JSON.stringify((json.json.diagnostics as any[]).map((item) => item.code))).toBeGreaterThan(0);
    for (const entry of unreadable) {
      expect(text.stdout + text.stderr, entry.code).toContain(entry.code);
    }
  }, 300_000);

  it('reaches a reader with every diagnostic the envelope carries, in the text form too', async () => {
    /*
     * The generic form of the same rule. `--text` is presentation only, so a diagnostic the JSON
     * reports and the readable form drops would be a finding that reaches a machine and not a
     * person — which is the wrong way round for the form a person is meant to read.
     */
    const built = await project().flow('solid').scope(['apps/web/**']).atStage('design').build();
    const json = await runCli(built.root, ['state', '--change', built.change]);
    const text = await runCli(built.root, ['state', '--change', built.change, '--text']);
    expect(json.json.diagnostics.length).toBeGreaterThan(0);
    for (const item of json.json.diagnostics) {
      expect(text.stdout, item.code).toContain(item.code);
    }
  }, 300_000);
});

async function readLedger(root: string, relative: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  return readFile(path.join(root, relative), 'utf8');
}
