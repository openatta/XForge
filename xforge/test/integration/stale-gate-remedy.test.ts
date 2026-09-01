import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

/**
 * The remedy a stale-Evidence notice offers, checked against what that command does.
 *
 * The notice said "Re-run these Gates before attempting the transition", and the command the
 * Skills prescribe around it is a plain `xforge check --change <id>`. That runs the Gates the
 * *current* Stage declares — and clarify and design declare none, so the run validated structure,
 * refreshed nothing, and re-emitted the same notice. A hand-driven Major run followed the
 * instruction, watched it not work, and only cleared it by finding `--gate` in a different Skill.
 */
describe('the stale Gate Evidence remedy', () => {
  const CHANGE = 'add-feature';

  it('names a command that refreshes the Gate, at a Stage that declares none', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    await runCli(root, ['transition', '--change', CHANGE, '--to', 'design']);
    /* Any Artifact write moves contentRevision and stales what passed before it. */
    await write(root, `xforge/changes/${CHANGE}/design.md`, '## Decisions\nRewritten, so the Evidence no longer binds.\n');

    const plain = await runCli(root, ['check', '--change', CHANGE]);
    const notice = (plain.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_GATE_EVIDENCE_STALE');
    expect(notice, JSON.stringify((plain.json.diagnostics as any[]).map((item) => item.code))).toBeDefined();
    /* The Stage declares no Gate, so the plain command it used to prescribe cannot clear this. */
    expect(notice.message).toContain(`--gate structure`);
    expect(notice.message).toContain('a Stage that declares none');

    /* And the named command does clear it. */
    const named = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    expect((named.json.diagnostics as any[]).map((item) => item.code)).not.toContain('XFORGE_GATE_EVIDENCE_STALE');
  });
});
