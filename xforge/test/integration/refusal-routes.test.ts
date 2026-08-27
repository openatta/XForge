import { describe, expect, it } from 'vitest';
import { project } from '../project-builder.js';
import { fixture, runCli, updateYaml, yamlFile } from '../helpers.js';

/**
 * Four refusals and one measure that a field report followed to the wrong place.
 *
 * The reporter's own summary is the frame worth keeping: none of these is a model defect. The
 * refusals are correct and stay correct — a Gate that reports success without running anything is
 * worse than one that fails, a delivery record really must be named after its execution, and code
 * that moved after a Gate ran really is worth knowing about. What each one lacked was the sentence
 * that says which of two problems the reader has.
 */
describe('refusals that name the route', () => {
  it('says a dismissal cannot make a declared Gate pass', async () => {
    const built = await project().flow('solid').atStage('check').build();
    const root = built.root;
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.builtin = 'declared';
      gate.spec.required = true;
      delete gate.spec.command;
    });
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { delete manifest.verification; });
    expect((await runCli(root, ['install'])).code).toBe(0);

    const result = await runCli(root, ['check', '--change', built.change, '--gate', 'unit-tests']);
    const text = JSON.stringify(result.json);

    /*
     * The reported path: the refusal offered `--command` and `--not-applicable` as two parallel
     * answers, so a real decision was recorded as two dismissals, the Gate kept failing, and the
     * operator read the CLI's own dist source to work out that only a command can produce a pass.
     */
    expect(text).toContain('a pass here always means a declared command ran and exited 0');
    expect(text).toContain('never stands in for a command');
  }, 300_000);

  it('still offers a dismissal as a real answer once commands exist', async () => {
    /*
     * The other half, and the reason the caveat is conditional rather than pinned to the message.
     * When a Gate already declares commands and a marker is merely unaccounted for, a dismissal
     * *is* the answer — telling that reader it achieves nothing would be false.
     */
    const { notDeclaredNextAction, uncoveredNextAction } = await import('../../src/core/verification.js');
    const marker = { marker: 'package.json', directory: '.', kind: 'npm', suggests: {} } as never;
    expect(notDeclaredNextAction('unit-tests', [marker]).reason).toContain('every dismissal here is inert');
    expect(uncoveredNextAction('unit-tests', [marker]).reason).not.toContain('inert');
    expect(uncoveredNextAction('unit-tests', [marker]).reason).toContain('deliberately does not cover');
  });

  it('warns when a dismissal names a marker nothing detected, without refusing it', async () => {
    const root = await fixture();
    const declared = await runCli(root, [
      'verification', 'declare', '--gate-name', 'unit-tests',
      '--not-applicable', 'no-scan-toolchain',
      '--justification', 'This Gate does not cover the scanner.', '--by', 'owner@example.test',
    ]);

    /* Accepted — the decision is real and worth keeping — and no longer silent about being inert. */
    expect(declared.code, JSON.stringify(declared.json?.diagnostics)).toBe(0);
    const warning = declared.json.diagnostics.find((item: any) => item.code === 'XFORGE_VERIFICATION_DISMISSAL_UNMATCHED');
    expect(warning.severity).toBe('warning');
    expect(warning.message).toContain('no-scan-toolchain');
    /*
     * Worded as "not among what was detected", never as "wrong". A repository whose build system
     * this CLI does not recognise has legitimate dismissals for markers that will never be
     * detected, and calling those an error would rebuild the dead end the first test removes.
     */
    expect(warning.message).toContain('no action is needed');
    expect(warning.message).toContain('verification retire');
    /* And it really was written: a warning, not a refusal. */
    const entries = (await yamlFile<any>(root, 'xforge/manifest.yaml')).verification['unit-tests'];
    expect(entries.some((entry: any) => entry.notApplicable === 'no-scan-toolchain')).toBe(true);
  }, 300_000);

  it('tells a file that is not a delivery record where it belongs', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await readFile(path.join(process.cwd(), 'src', 'core', 'work-packages', 'records.ts'), 'utf8');
    /*
     * A live Major put a Reviewer's verbatim transcript at `review-<execution>.yaml` and spent six
     * rounds on the resulting DELIVERY_PATH_MISMATCH, including a bisect by moving files out of the
     * directory and back. The Skills route around it now; the refusal still has to say which of the
     * two problems the reader has.
     */
    const message = /const NOT_A_DELIVERY = '([^']*)'/.exec(source)?.[1] ?? '';
    expect(message).toContain('in the wrong place rather than malformed');
    expect(message).toContain('review/');
    expect(source).toContain('${NOT_A_DELIVERY}');
  });

  it('does not count a governance answer as the code moving', async () => {
    /* One package, because the builder makes the fixture a real Git repository only when the plan
       needs one — and this measure is a diff between two commits. */
    const built = await project().flow('solid').packages(1).atStage('check').build();
    expect((await runCli(built.root, ['check', '--change', built.change])).code).toBe(0);

    const before = await runCli(built.root, ['state', '--change', built.change]);
    const drift = (summary: any): number | null => summary.mandatoryGateEvidence
      ?.find((entry: any) => entry.gate === 'structure')?.sourceFilesChangedSince ?? null;
    expect(drift(before.json.data.change)).toBe(0);

    /*
     * An ordinary governance answer, written by the CLI itself into a file it owns, and committed.
     * A live Major did exactly this and watched all five of its Gates get reported
     * `staleAgainstCode` — while `contentRevision` had not moved and archive accepted the Change
     * without complaint. The reader is left deciding whether the evidence chain is broken.
     */
    expect((await runCli(built.root, [
      'verification', 'declare', '--gate-name', 'unit-tests',
      '--command', `["${process.execPath}","-e","process.exit(0)"]`, '--by', 'owner@example.test',
    ])).code).toBe(0);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('git', ['-C', built.root, 'add', '.']);
    await run('git', ['-C', built.root, 'commit', '-qm', 'declare verification']);

    const after = await runCli(built.root, ['state', '--change', built.change]);
    expect(drift(after.json.data.change)).toBe(0);
  }, 600_000);
});
