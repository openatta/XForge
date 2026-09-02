import { describe, expect, it } from 'vitest';
import { changeYaml, createCompleteSolidChange, fixture, runCli, write } from '../helpers.js';

/**
 * Where a fact about the project's configuration is reported, and where it is not.
 *
 * `XFORGE_RULE_OUT_OF_CHANGE_SCOPE` catches a real defect — a `must` Rule whose `scope.paths` match
 * nothing this Change declares is absent from `governance.rules` entirely, so the Change proceeds as
 * though it had never been written — and it was emitted by every command that resolved the control
 * plane. A live run counted it more than twenty times in one scenario and said it "trains an agent
 * to skim diagnostics", which is the opposite of what the diagnostics beside it need.
 *
 * It stays on the call path rather than moving to `doctor`: the failure it exists to catch is that
 * nobody noticed, and a command people run rarely is where not noticing happens. But `state` is the
 * question it answers — `check` asks whether something passed, `transition` whether it may move.
 */
describe('a project-configuration fact', () => {
  const CHANGE = 'add-feature';

  it('is reported by state', async () => {
    const root = await fixture();
    await write(root, `xforge/changes/${CHANGE}/change.yaml`, changeYaml('solid'));
    const read = await runCli(root, ['state', '--change', CHANGE]);
    const found = (read.json.diagnostics as any[]).filter((item) => item.code === 'XFORGE_RULE_OUT_OF_CHANGE_SCOPE');
    expect(found.length, JSON.stringify((read.json.diagnostics as any[]).map((item) => item.code))).toBe(1);
    /* Short enough to read every time it appears, and it says where the long form lives. */
    expect(found[0].message.length).toBeLessThan(260);
    expect(found[0].message).toContain('xforge doctor');
  });

  it('is not repeated by check, which was asked a different question', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root, CHANGE);
    const ran = await runCli(root, ['check', '--change', CHANGE, '--gate', 'structure']);
    expect((ran.json.diagnostics as any[]).map((item) => item.code))
      .not.toContain('XFORGE_RULE_OUT_OF_CHANGE_SCOPE');
  });
});
