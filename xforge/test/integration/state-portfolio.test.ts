import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeYaml, fixture, runCli, write } from '../helpers.js';

/*
 * `state` without `--change` used to answer only "which Change directories exist". Once Changes run
 * in parallel the operative question is "what is in flight and where is each one stuck", and
 * answering it cost one `state --change <id>` process per Change — so nobody asked it. `activeChanges`
 * carries the Flow, Stage, and risk for every un-archived Change in the one call that already runs.
 */
describe('state portfolio view', () => {
  async function activeChanges(root: string): Promise<any[]> {
    const result = await runCli(root, ['state']);
    expect(result.code).toBe(0);
    return result.json.data.activeChanges;
  }

  it('reports Flow, Stage, and risk for every un-archived Change', async () => {
    const root = await fixture();
    try {
      await write(root, 'xforge/changes/fast-fix/change.yaml', changeYaml('quick'));
      await write(root, 'xforge/changes/bigger-thing/change.yaml', changeYaml('solid'));

      expect(await activeChanges(root)).toEqual([
        { id: 'bigger-thing', flow: 'solid', stage: 'propose', risk: 'medium' },
        { id: 'fast-fix', flow: 'quick', stage: 'propose', risk: 'low' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('omits archived Changes and the archive directory itself', async () => {
    const root = await fixture();
    try {
      await write(root, 'xforge/changes/still-open/change.yaml', changeYaml('quick'));
      await write(root, 'xforge/changes/archive/2026-01-01-done/change.yaml', changeYaml('quick'));

      expect((await activeChanges(root)).map((item) => item.id)).toEqual(['still-open']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /*
   * A Change whose config will not load is the one most likely to need attention, so it is listed
   * with nulls rather than dropped: a portfolio that silently omits its broken entries reads as
   * healthy at exactly the moment it is not.
   */
  it('still lists a Change whose config cannot be resolved, with null Flow and Stage', async () => {
    const root = await fixture();
    try {
      await write(root, 'xforge/changes/healthy/change.yaml', changeYaml('quick'));
      await write(root, 'xforge/changes/malformed/change.yaml', 'flow: quick\nscope: not-an-object\n');
      await mkdir(path.join(root, 'xforge', 'changes', 'empty-dir'), { recursive: true });

      const listed = await activeChanges(root);
      expect(listed.map((item) => item.id)).toEqual(['empty-dir', 'healthy', 'malformed']);
      expect(listed.find((item) => item.id === 'malformed')).toEqual({ id: 'malformed', flow: null, stage: null, risk: null });
      expect(listed.find((item) => item.id === 'empty-dir')).toEqual({ id: 'empty-dir', flow: null, stage: null, risk: null });
      expect(listed.find((item) => item.id === 'healthy')?.stage).toBe('propose');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
