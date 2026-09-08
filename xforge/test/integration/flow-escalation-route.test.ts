/*
 * @red-first coverage-only: type-level only. The test tree came under `tsc` for the first time (`npm run typecheck`, tsconfig.test.json) and this file was edited so it compiles. No assertion was added, changed or removed, so there is nothing here that could fail against the base.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeYaml, fixture, runCli, updateYaml, write } from '../helpers.js';

/**
 * What a Change refused by its Flow is told to do next.
 *
 * `quick.yaml` says of `contractImpact` that "the escalation names the Flow that can", and it did
 * not: `XFORGE_FLOW_TOO_WEAK` stated the problem and stopped. An Agent left to guess has one move
 * that always works — clear the classification key — and that is the single move which defeats the
 * check, since nothing compares `moduleContract` with the diff.
 *
 * Naming nothing is also an answer, and a different one. A project holding no eligible Flow needs a
 * person to adopt one; telling it to try another Flow would send it round the same loop.
 *
 * Written against `quick` since 0.8.4. `solid` and `major` both carry a declared interface change
 * now, which leaves `quick` as the one shipped Flow that structurally cannot -- no design Stage to
 * write a delta in, and no reviewer to read one. That is the case this refusal exists for, and the
 * one an ordinary project actually meets.
 */
describe('the route out of an ineligible Flow', () => {
  const CHANGE = 'moves-an-interface';

  async function changeThatMovesAnInterface(root: string): Promise<void> {
    await write(root, `xforge/changes/${CHANGE}/change.yaml`, changeYaml('quick', {
      classification: { risk: 'low', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
    }));
  }

  async function tooWeak(root: string): Promise<string> {
    const result = await runCli(root, ['check', '--change', CHANGE]);
    const found = (result.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_FLOW_TOO_WEAK');
    expect(found, `no XFORGE_FLOW_TOO_WEAK in ${JSON.stringify(result.json.diagnostics)}`).toBeDefined();
    return found.message as string;
  }

  it('says so plainly when the project has no Flow that could carry the Change', async () => {
    const root = await fixture();
    /* A project that runs Quick and nothing else, which is a real shape: the two Flows that could
       carry an interface change are removed rather than merely unselected, so the escalation has
       genuinely nothing to name. */
    await runCli(root, ['uninstall', '--force']);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest: any) => {
      manifest.scaffold.flows = ['quick'];
      manifest.flow = 'quick';
    });
    await rm(path.join(root, 'xforge', 'flows', 'solid.yaml'), { force: true });
    await rm(path.join(root, 'xforge', 'flows', 'major.yaml'), { force: true });
    await runCli(root, ['install']);
    await changeThatMovesAnInterface(root);

    const message = await tooWeak(root);
    expect(message).toContain('No Flow this project has is eligible');
    /* And says what to do with that, because "try another Flow" is the wrong next move here. */
    expect(message).toContain('a decision for a person');
  });

  it('names the Flow the project already has that is eligible', async () => {
    const root = await fixture();
    await changeThatMovesAnInterface(root);

    /* No adoption step any more: `solid` ships able to carry this, so the escalation has a Flow to
       name out of the box. That the message names one rather than saying "none" is the property --
       an Agent told only that Quick refuses has one move that always works, and it is the move that
       defeats the check. */
    const message = await tooWeak(root);
    expect(message).toContain('solid');
    expect(message).not.toContain('No Flow this project has is eligible');
  });
});
