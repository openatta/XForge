import { readFile } from 'node:fs/promises';
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
 */
describe('the route out of an ineligible Flow', () => {
  const CHANGE = 'moves-an-interface';

  async function changeThatMovesAnInterface(root: string): Promise<void> {
    await write(root, `xforge/changes/${CHANGE}/change.yaml`, changeYaml('solid', {
      classification: { risk: 'medium', security: false, privacy: false, publicApi: false, dataMigration: false, moduleContract: true },
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
    await changeThatMovesAnInterface(root);
    const message = await tooWeak(root);
    expect(message).toContain('No Flow this project has is eligible');
    /* And says what to do with that, because "try another Flow" is the wrong next move here. */
    expect(message).toContain('a decision for a person');
  });

  it('names the Flow once the project has adopted one that is eligible', async () => {
    const root = await fixture();
    await changeThatMovesAnInterface(root);
    const template = await readFile(path.join(root, 'xforge', 'scaffold', 'flows', 'solid-contract.yaml'), 'utf8');
    await write(root, 'xforge/flows/solid-contract.yaml', template);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest: any) => {
      manifest.scaffold.flows = [...manifest.scaffold.flows, 'solid-contract'];
    });
    await runCli(root, ['install']);

    const message = await tooWeak(root);
    expect(message).toContain('solid-contract');
    expect(message).not.toContain('No Flow this project has is eligible');
  });
});
