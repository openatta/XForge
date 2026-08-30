import { spawn } from 'node:child_process';
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
    /* The others are named, so "what else is there" is still answerable, but not described. */
    const listed = (one.json.data as any).commands;
    expect(Array.isArray(listed)).toBe(true);
    expect(listed).toContain('approve');
    expect(listed).not.toContain('verification');
    expect(one.stdout.length).toBeLessThan(index.stdout.length / 2);

    /* Bare `help` is untouched: there the index is the answer, not the overhead. */
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
});
