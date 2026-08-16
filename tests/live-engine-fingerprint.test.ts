import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryRoot } from '../xforge/test/helpers.js';
import { scaffoldFingerprint } from './live-engine/cassette.mjs';

const manifestPath = path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'manifest.yaml');

/**
 * A cassette records the Scaffold fingerprint it was made against so that replaying over a changed
 * Scaffold is refused: a replay re-executes tooling, never the model, so it cannot speak for a Skill
 * whose wording moved. The value of that refusal depends entirely on the fingerprint tracking
 * *instructions the Agent reads* and nothing else.
 *
 * It did not. Hashing `scaffold/files.sha256` covered `manifest.yaml`'s version fields and
 * `lock.yaml`, so `npm run release:prepare` invalidated all four cassettes on every release while
 * every Skill, Flow, Gate, Rule and policy stayed byte-identical — a false refusal whose price is a
 * paid re-record of every scenario. These two tests pin both halves of the corrected rule.
 */
describe('live-engine Scaffold fingerprint', () => {
  async function withManifest<T>(mutate: (text: string) => string, body: () => Promise<T>): Promise<T> {
    const original = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, mutate(original));
    try { return await body(); } finally { await writeFile(manifestPath, original); }
  }

  it('does not move when a release bumps versions', async () => {
    const before = scaffoldFingerprint();
    const after = await withManifest(
      (text) => text.replace(/version: 0\.\d+\.\d+/g, 'version: 99.99.99'),
      async () => scaffoldFingerprint(),
    );
    expect(after).toBe(before);
  });

  /*
   * The other half: `scaffold.skills` decides which Skills an Agent actually has, so enabling or
   * removing one has to keep refusing an older cassette. Excluding the whole manifest would have
   * been the simpler fix and would have silently dropped this.
   */
  it('moves when the enabled Skill set changes', async () => {
    const before = scaffoldFingerprint();
    const after = await withManifest(
      (text) => text.replace('    - xforge-kanban\n', ''),
      async () => scaffoldFingerprint(),
    );
    expect(after).not.toBe(before);
  });

  it('moves when a Skill body changes', async () => {
    const skill = path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'scaffold', 'skills', 'xforge-status', 'SKILL.md');
    const before = scaffoldFingerprint();
    const original = await readFile(skill, 'utf8');
    await writeFile(skill, `${original}\n<!-- wording drift -->\n`);
    try {
      expect(scaffoldFingerprint()).not.toBe(before);
    } finally {
      await writeFile(skill, original);
    }
  });
});
