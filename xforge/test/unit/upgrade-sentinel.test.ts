import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/types.js';
import { UPGRADE_SENTINEL } from '../../src/core/ownership-zones.js';
import { parseStagedUpgrade, readStagedUpgrade, upgradeInProgressDiagnostic } from '../../src/core/upgrade-sentinel.js';
import { executeCheck } from '../../src/commands/check.js';
import { executeDoctor } from '../../src/commands/doctor.js';
import { executeState } from '../../src/commands/state.js';
import { executeTransition } from '../../src/commands/transition.js';
import { loadProject } from '../../src/core/project-loader.js';
import { createCompleteSolidChange, fixture, temporaryDirectory, write } from '../helpers.js';

/**
 * The half of the sentinel that reads it.
 *
 * `xforge/UPGRADING.md` is written when an upgrade is staged and removed when `--complete` or
 * `--rollback` closes it, and until that writer lands there is no project anywhere — on disk or in
 * this suite's fixtures — that has one. So the case these tests care about most is the one that
 * looks like nothing: the marker is absent, and the four commands say exactly what they said
 * before. A notice that arrives when no upgrade is open is not a smaller failure than one that
 * never arrives; it is the same failure aimed at every project instead of one.
 *
 * The rest is the marker in the states a half-finished thing is actually found in — written as
 * intended, mangled by whoever was mid-merge, and unreadable — held to one rule: warn, never refuse.
 */

const CODE = 'XFORGE_UPGRADE_IN_PROGRESS';
const CHANGE = 'add-feature';

const MARKER = [
  '# Scaffold upgrade in progress',
  '',
  '- From: 4.1.0',
  '- To: 4.2.0',
  '',
  'Finish the merge, then run `xforge upgrade-scaffold --complete`.',
  '',
].join('\n');

const raised = (diagnostics: Diagnostic[]): Diagnostic[] => diagnostics.filter((item) => item.code === CODE);
const failing = (diagnostics: Diagnostic[]): boolean => diagnostics.some((item) => item.severity === 'error');
const codes = (diagnostics: Diagnostic[]): string[] => diagnostics.map((item) => item.code).sort();

describe('reading the marker an unfinished upgrade leaves behind', () => {
  it('reports nothing at all when the file is absent', async () => {
    expect(await readStagedUpgrade(await temporaryDirectory())).toBeNull();
  });

  it('reads the version span out of the prose around it', async () => {
    const root = await temporaryDirectory();
    await write(root, UPGRADE_SENTINEL, MARKER);
    expect(await readStagedUpgrade(root)).toEqual({ fromVersion: '4.1.0', toVersion: '4.2.0' });
  });

  it('finds the fields wherever in the file they are, and ignores everything else', () => {
    /* The file is Markdown written for a person. A heading above the fields, a note somebody added
       partway through the merge, and a table of what was staged are all things a real marker will
       carry, and none of them is a reason to lose the span. */
    expect(parseStagedUpgrade([
      '# Upgrade',
      'Do not delete this file; it is what tells the rest of the CLI the merge is unfinished.',
      '',
      '  * to: `4.3.0`',
      'notes: paused on Thursday, three Gates still to review',
      '- From: 4.2.0',
    ].join('\n'))).toEqual({ fromVersion: '4.2.0', toVersion: '4.3.0' });
  });

  it('reads a span written as a heading when there are no fields to read', () => {
    expect(parseStagedUpgrade('# Scaffold upgrade 4.1.0 → 4.2.0\n')).toEqual({ fromVersion: '4.1.0', toVersion: '4.2.0' });
  });

  it('calls `unknown` no version, because that is what stage writes when the pin is missing', () => {
    expect(parseStagedUpgrade('- From: unknown\n- To: 4.2.0\n')).toEqual({ fromVersion: null, toVersion: '4.2.0' });
  });

  it('reports a mangled marker as an upgrade with an unknown span, never as no upgrade', async () => {
    /*
     * The one that decides whether this is worth having. A marker exists for the case where things
     * are half-finished, so the state where it has been half-edited is the state it was written
     * for — and reading "I cannot parse this" as "no upgrade is in progress" would drop the warning
     * exactly where it is most deserved.
     */
    const root = await temporaryDirectory();
    await write(root, UPGRADE_SENTINEL, 'something ate this file\n');
    expect(await readStagedUpgrade(root)).toEqual({ fromVersion: null, toVersion: null });
    expect(upgradeInProgressDiagnostic((await readStagedUpgrade(root))!).severity).toBe('warning');
  });

  it('answers null for a path it cannot read, rather than throwing or guessing', async () => {
    /* A directory where the file should be: something is there and nothing about it can be read.
       That is the absence of evidence either way, and announcing a staged upgrade on the strength
       of a failed read would put the warning on projects that never staged one. */
    const root = await temporaryDirectory();
    await mkdir(path.join(root, ...UPGRADE_SENTINEL.split('/')), { recursive: true });
    await expect(readStagedUpgrade(root)).resolves.toBeNull();
  });

  it('names the versions it knows and both commands that close the upgrade', () => {
    const known = upgradeInProgressDiagnostic({ fromVersion: '4.1.0', toVersion: '4.2.0' });
    expect(known.severity).toBe('warning');
    expect(known.path).toBe(UPGRADE_SENTINEL);
    expect(known.message).toContain('4.1.0');
    expect(known.message).toContain('4.2.0');
    expect(known.message).toContain('xforge upgrade-scaffold --complete');
    expect(known.message).toContain('--rollback');

    const unknown = upgradeInProgressDiagnostic({ fromVersion: null, toVersion: null });
    expect(unknown.severity).toBe('warning');
    expect(unknown.message).toContain('xforge upgrade-scaffold --complete');
    expect(unknown.message).toContain('--rollback');
  });
});

describe('the commands that notice it', () => {
  it('says nothing on a project with no marker, which is every project there is', async () => {
    const root = await fixture();
    const project = await loadProject(root, { exactRoot: true });

    const doctor = await executeDoctor(project, { strict: false });
    const state = await executeState(project, {});
    const check = await executeCheck(project, {});

    expect(raised(doctor.diagnostics)).toEqual([]);
    expect(raised(state.diagnostics)).toEqual([]);
    expect(raised(check.diagnostics)).toEqual([]);
  });

  it('warns from doctor, state and check without changing what any of them decided', async () => {
    const root = await fixture();
    const project = await loadProject(root, { exactRoot: true });
    const before = {
      doctor: await executeDoctor(project, { strict: false }),
      state: await executeState(project, {}),
      check: await executeCheck(project, {}),
    };
    await write(root, UPGRADE_SENTINEL, MARKER);
    const after = {
      doctor: await executeDoctor(project, { strict: false }),
      state: await executeState(project, {}),
      check: await executeCheck(project, {}),
    };

    for (const command of ['doctor', 'state', 'check'] as const) {
      const warning = raised(after[command].diagnostics);
      expect(warning.length, `${command} raised ${warning.length} of ${CODE}`).toBe(1);
      expect(warning[0]!.severity).toBe('warning');
      expect(warning[0]!.path).toBe(UPGRADE_SENTINEL);
      expect(warning[0]!.message).toContain('4.2.0');
      /* Warn, never refuse: the added diagnostic is the only difference, and it is not an error. */
      expect(codes(after[command].diagnostics)).toEqual([...codes(before[command].diagnostics), CODE].sort());
      expect(failing(after[command].diagnostics)).toBe(failing(before[command].diagnostics));
    }
    /* doctor's report itself is untouched. A finding would have been counted into `summary`, and
       every count there feeds `--strict` — which would turn this warning into a refusal in CI. */
    expect(after.doctor.data.summary).toEqual(before.doctor.data.summary);
    expect(failing(after.doctor.diagnostics)).toBe(false);
  });

  it('tells transition what it is specifically about to do, and still lets it happen', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const project = await loadProject(root, { exactRoot: true });
    await executeCheck(project, { change: CHANGE, gate: 'structure' });

    const before = await executeTransition(project, { change: CHANGE, to: 'design', dryRun: true });
    await write(root, UPGRADE_SENTINEL, MARKER);
    const after = await executeTransition(project, { change: CHANGE, to: 'design', dryRun: true });

    const warning = raised(after.diagnostics);
    expect(warning.length).toBe(1);
    expect(warning[0]!.severity).toBe('warning');
    /* The one command where the hazard is real, so it says which hazard rather than reusing the
       general wording: a Stage advancing under Gates and a Flow that are mid-merge. */
    expect(warning[0]!.message).toContain('half-merged Gates and Flows');
    expect(warning[0]!.message).toContain('xforge upgrade-scaffold --complete');

    expect(raised(before.diagnostics)).toEqual([]);
    expect(codes(after.diagnostics)).toEqual([...codes(before.diagnostics), CODE].sort());
    expect(after.data.ready).toBe(before.data.ready);
    expect(failing(after.diagnostics)).toBe(failing(before.diagnostics));
    /* The rehearsal still plans the receipt it planned before. A warning that quietly changed what
       the command would do would be the refusal this is not supposed to be, wearing another name. */
    expect(after.changes.map((change) => change.path)).toEqual(before.changes.map((change) => change.path));
  });
});
