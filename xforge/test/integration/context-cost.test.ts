import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeYaml, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

/*
 * Four costs an end-to-end run measured, and the refusals it could not act on.
 *
 * The run drove a Major Change from `CLAUDE.md` to the first approval gate and recorded every CLI
 * invocation. Three `help` calls cost more of its context than the ten `state --field` calls that
 * XFORGE.md's whole cost argument is built around, `check` was the largest recurring output and the
 * one command `--field` did not reach, and two blocks named a condition without naming what to do.
 */
async function git(root: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, shell: false, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`)));
  });
}

describe('what a Stage pays to read', () => {
  it('answers help for one command without reprinting every other command', async () => {
    const root = await fixture();
    const one = await runCli(root, ['help', 'verification']);
    const index = await runCli(root, ['help']);

    /* The command asked about is answered in full. */
    expect((one.json.data as any).commandHelp.usage).toContain('verification');
    /* The others are named, so "what else is there" is still answerable, but not described. Under
       a key of its own: `commands` keeps one type, and its absence is what says the reply narrowed. */
    const listed = (one.json.data as any).otherCommands;
    expect((one.json.data as any).commands).toBeUndefined();
    expect(Array.isArray(listed)).toBe(true);
    expect(listed).toContain('approve');
    expect(listed).not.toContain('verification');
    expect(one.stdout.length).toBeLessThan(index.stdout.length / 2);

    /* Bare `help` is untouched: there the index is the answer, not the overhead. */
    expect((index.json.data as any).otherCommands).toBeUndefined();
    expect(Array.isArray((index.json.data as any).commands)).toBe(false);
    expect((index.json.data as any).commands.verification).toContain('declared-verification Gate');
  });

  it('lets --field reach the check result, which is the largest thing a Stage re-reads', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const full = await runCli(root, ['check', '--change', 'add-feature']);
    const narrow = await runCli(root, ['check', '--change', 'add-feature', '--field', 'gates']);

    expect(narrow.code).toBe(0);
    expect(narrow.stdout.length).toBeLessThan(full.stdout.length / 2);
    const idsAndStatus = (gates: any[]) => gates.map((gate) => [gate.id, gate.status]);
    expect(idsAndStatus(JSON.parse(narrow.stdout))).toEqual(idsAndStatus((full.json.data as any).gates));
  });

  /*
   * `undecided-4` over four entries whose every field was populated. The reason was computed and
   * dropped one line later, so the run read the CLI's own source to find it.
   */
  it('says which ledger entries are undecided and why, not just how many', async () => {
    const root = await fixture();
    const base = 'xforge/changes/add-feature';
    await write(root, `${base}/change.yaml`, changeYaml('major'));
    await write(root, `${base}/proposal.md`, [
      '## Why', 'w', '## Scope', 's', '## Non-goals', 'n', '## Actors and success criteria', 'a',
      '## Flow choice', 'major', '## Critical impacts and rollback', 'r', '',
    ].join('\n'));
    await write(root, `${base}/specs/widget/spec.md`, '## ADDED Requirements\n\n### Requirement: Widget works\n\n#### Scenario: success\n- **WHEN** used\n- **THEN** it works\n');
    /*
     * Committed, so the Change has an attestable identity to be measured against. Without a commit
     * `known.empty` holds and every name is accepted — deliberately, so a new repository's first
     * Change is not blocked — which is a different state from the one this asserts.
     */
    await git(root, ['init', '-q']);
    await git(root, ['config', 'user.email', 'author@example.test']);
    await git(root, ['config', 'user.name', 'Author']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-qm', 'change']);
    /* The condition is Clarify's exit condition, so it is only evaluated from Clarify. */
    await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure']);
    const moved = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'clarify']);
    expect(moved.code, JSON.stringify(moved.json?.diagnostics)).toBe(0);
    await write(root, `${base}/evidence/conditions/materialQuestions.yaml`, [
      'condition: materialQuestions', 'status: resolved', 'entries:',
      '  - id: Q1', '    question: Which shape?', '    impact: high',
      '    decision: The first one', '    decidedBy: nobody@example.test', '    decidedAt: 2026-08-28T00:00:00Z',
      '  - id: Q2', '    question: And the boundary?', '    impact: low',
      '    decision: Inclusive', '    decidedAt: 2026-08-28T00:00:00Z',
      '',
    ].join('\n'));

    const said = JSON.stringify((await runCli(root, ['state', '--change', 'add-feature'])).json.diagnostics);
    expect(said).toContain('XFORGE_CONDITION_LEDGER_UNDECIDED_REMEDY');
    /* Which ones, by their own ids. */
    expect(said).toContain('Q1');
    expect(said).toContain('Q2');
    /* And why each: an unattestable name, and a field that is simply absent. */
    expect(said).toContain('nobody@example.test');
    /* And it lists the names that would have passed, which is the standard the constitution-check
       Gate already set for the identical check. */
    expect(said).toContain('author@example.test');
    expect(said).toContain('has no decidedBy');
  });

  /*
   * `transition` writes a receipt, which dirties the Change directory, which makes the very next
   * `stage-bundle` list every Artifact instead of the set that moved. The command that creates the
   * condition is the one that can name it.
   */
  it('warns that its own receipt is what will make the next stage-bundle useless', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure']);
    const moved = await runCli(root, ['transition', '--change', 'add-feature', '--to', 'design']);

    expect(moved.code).toBe(0);
    const said = (moved.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_TRANSITION_RECEIPT_UNCOMMITTED');
    expect(said, JSON.stringify(moved.json.diagnostics)).toBeTruthy();
    expect(said.severity).toBe('info');
    expect(said.message).toContain('stage-bundle');
    expect(said.message).toContain('Commit the receipt');
  });
  /*
   * The call a Stage makes immediately after a refusal is `--field diagnostics`, asking what went
   * wrong — and until now that was answered with the whole resolved project, because `--field` was
   * applied only to `ok` results. A measured Major run spent 105KB that way, 27% of everything the
   * CLI said to it, over five calls that each asked for one value.
   *
   * A work-package plan in a project that is not a Git worktree is the shape that produces it: the
   * envelope is fully built and then refused, which is exactly when a narrowed read is worth most.
   */
  it('answers a failed call with the field that was asked for, not the whole project', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, 'xforge/changes/add-feature/work-packages.yaml', [
      'apiVersion: xforge.dev/v1alpha1', 'kind: WorkPackagePlan', 'packages:', '  - id: T001', '    goal: Implement T001', '    depends_on: []',
      '    inputs: ["xforge/changes/add-feature/design.md"]', '    write_paths: ["src/order/**"]',
      '    skills: ["xforge-apply"]', '    verify: [["npm", "test"]]',
      '    done_when: ["T001 is covered by an automated check"]', '',
    ].join('\n'));

    const full = await runCli(root, ['state', '--change', 'add-feature']);
    const narrow = await runCli(root, ['state', '--change', 'add-feature', '--field', 'diagnostics']);

    expect(full.code, full.stdout.slice(0, 400)).toBe(1);
    expect(narrow.code).toBe(1);
    /* Still a refusal: `ok` false and the exit code unchanged. Only `data` narrowed. */
    expect(narrow.json.ok).toBe(false);
    expect(narrow.stdout.length).toBeLessThan(full.stdout.length / 4);
    /* The sections nobody asked for are gone, including the largest ones. */
    for (const absent of ['"installation"', '"resources"', '"flows"', '"artifacts"']) {
      expect(narrow.stdout, `${absent} was not asked for`).not.toContain(absent);
    }
    /* And the value asked for is there. `diagnostics` is an envelope field, so it arrives once, at
       the envelope level, rather than being copied into `data` as well. */
    expect(narrow.json.data).toBeNull();
    expect(JSON.stringify(narrow.json.diagnostics)).toContain('XFORGE_WORK_PACKAGE_GIT_REQUIRED');

    /* A path that does live in `data` comes back inside it, and still nothing else does. */
    const inData = await runCli(root, ['state', '--change', 'add-feature', '--field', 'change.governance.currentStage']);
    expect(inData.code).toBe(1);
    expect(Object.keys(inData.json.data as object)).toEqual(['change.governance.currentStage']);
  });

  /*
   * Every `--field` example in the contract document, executed.
   *
   * `XFORGE.md` is the one file every Stage reads before it calls anything, so a command written
   * there is a command Agents will run verbatim. One shipped naming `check --field blockedBy` —
   * a field `check` does not have — and because `--field` is all or nothing, an Agent following it
   * got `XFORGE_FIELD_NOT_FOUND`, exit 1, and none of the `gates` it had also asked for. A live run
   * found it; nothing in the suite could have, because no test ran what the document says to run.
   */
  it('runs every --field example the contract document gives, and each one resolves', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const contract = await readFile(join(root, 'xforge', 'XFORGE.md'), 'utf8');

    const examples = [...contract.matchAll(/`(xforge [^`]*--field[^`]*)`/gu)]
      .map((match) => match[1]!.replace(/<id>/gu, 'add-feature'));
    /* The document is the source of the list, so an example added later is covered without this
       test changing — and a document that stops giving examples fails here rather than passing
       vacuously. */
    expect(examples.length).toBeGreaterThanOrEqual(2);

    for (const example of examples) {
      const result = await runCli(root, example.split(/\s+/u).slice(1));
      expect(result.code, `${example} -> ${result.stdout.slice(0, 300)}`).toBe(0);
    }
  });
  /*
   * Every Stage Skill's own opening call, executed.
   *
   * A Skill's Invariant is copied verbatim by the Stage that reads it, so a path that does not
   * resolve there breaks a Stage's first act — and `--field` is all or nothing, so it breaks the
   * whole call rather than one value. These were `--field change`, which is 60% of the envelope;
   * they name what each Stage acts on now, and this runs each of them.
   */
  it('runs every Stage Skill opening call, and each one resolves', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const skills = join(root, 'xforge', 'scaffold', 'skills');
    const names = (await readdir(skills)).filter((name) => name.startsWith('xforge-'));

    const invariants: Array<{ skill: string; command: string }> = [];
    for (const name of names) {
      const text = await readFile(join(skills, name, 'SKILL.md'), 'utf8').catch(() => '');
      for (const match of text.matchAll(/`(xforge state [^`]*--field[^`]*)`/gu)) {
        invariants.push({ skill: name, command: match[1]!.replace(/<id>/gu, 'add-feature') });
      }
    }
    expect(invariants.length).toBeGreaterThanOrEqual(6);

    for (const { skill, command } of invariants) {
      const result = await runCli(root, command.split(/\s+/u).slice(1));
      expect(result.code, `${skill}: ${command} -> ${result.stdout.slice(0, 300)}`).toBe(0);
    }
  });

  /*
   * And what the narrowing bought, asserted as a property rather than a number: the Stage call
   * costs a fraction of the envelope it was taking most of.
   */
  it('leaves a Stage reading a fraction of what --field change returned', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const narrow = await runCli(root, ['state', '--change', 'add-feature',
      '--field', 'nextActions', '--field', 'diagnostics', '--field', 'change.governance', '--field', 'change.nextArtifact']);
    const wide = await runCli(root, ['state', '--change', 'add-feature',
      '--field', 'nextActions', '--field', 'diagnostics', '--field', 'change']);

    expect(narrow.code).toBe(0);
    expect(narrow.stdout.length).toBeLessThan(wide.stdout.length * 0.75);
    /* Everything a Stage decides against is still there: which Stage it is on, what is ready, and
       the Rules — `governance.rules` is how a Rule reaches an Agent at all. */
    const value = JSON.parse(narrow.stdout);
    expect(value['change.governance'].currentStage).toBeTruthy();
    expect(Array.isArray(value['change.governance'].readyTransitions)).toBe(true);
    expect(Array.isArray(value['change.governance'].rules)).toBe(true);
    expect(value['change.governance'].revision.contentRevision).toBeTruthy();
  });
});
