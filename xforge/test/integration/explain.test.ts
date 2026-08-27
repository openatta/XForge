import { describe, expect, it } from 'vitest';
import { fixture, runCli, temporaryDirectory } from '../helpers.js';

/**
 * What a diagnostic code means, asked of the CLI instead of of the source.
 *
 * A field report's phrasing was "key semantics are only readable in the source". It is accurate: the
 * product can emit several hundred codes, each message is written at its call site, and a reader who
 * wants more than the one line they just saw has to open a file they do not have. An Agent in that
 * position has no move at all.
 *
 * Deliberately no new prose per code — the messages here are already long and specific, and a second
 * description per code would be three hundred entries nobody has written, going stale against the
 * messages they exist to explain. What this adds is the part a single sighting cannot give: the
 * severity, and *every* wording the code can carry.
 */
describe('xforge explain', () => {
  it('answers with the severity and the message, from a build that ships the catalogue', async () => {
    const root = await fixture();
    const result = await runCli(root, ['explain', 'XFORGE_STAGE_BUNDLE_TREE_DIRTY']);
    expect(result.code, JSON.stringify(result.json?.diagnostics)).toBe(0);
    expect(result.json.data.code).toBe('XFORGE_STAGE_BUNDLE_TREE_DIRTY');
    expect(result.json.data.severities).toEqual(['info']);
    expect(result.json.data.messages).toHaveLength(1);
    expect(result.json.data.messages[0].message).toContain('compares commits');
    expect(result.json.data.messages[0].raisedIn).toContain('src/commands/stage-bundle.ts');
  }, 600_000);

  it('gives every wording when one code is raised from several places', async () => {
    /*
     * The half a single sighting cannot give. `XFORGE_SPEC_MERGE_CONFLICT` is raised three times and
     * each one describes a different situation; a reader who has met one of them learns from this
     * that the other two exist, which is exactly what they could not find out before.
     */
    const root = await fixture();
    const result = await runCli(root, ['explain', 'XFORGE_SPEC_MERGE_CONFLICT']);
    expect(result.code).toBe(0);
    expect((result.json.data.messages as unknown[]).length).toBeGreaterThan(1);
    const text = await runCli(root, ['explain', 'XFORGE_SPEC_MERGE_CONFLICT', '--text']);
    expect(text.stdout).toContain('raised from 3 places');
  }, 600_000);

  it('answers outside a project, because a code can be met anywhere', async () => {
    /*
     * Beside `help` and `version` rather than behind a project resolve: a reader who hit a code in a
     * directory that is not an XForge project still needs the answer, and refusing them there would
     * make the command useless in the situation it is most needed.
     */
    const empty = await temporaryDirectory('xforge-explain-');
    const result = await runCli(empty, ['explain', 'XFORGE_STAGE_BUNDLE_NO_BASELINE']);
    expect(result.code, JSON.stringify(result.json?.diagnostics)).toBe(0);
    expect(result.json.data.code).toBe('XFORGE_STAGE_BUNDLE_NO_BASELINE');
  }, 600_000);

  it('names near misses rather than only refusing', async () => {
    const root = await fixture();
    const result = await runCli(root, ['explain', 'XFORGE_STAGE_BUNDLE']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics[0].code).toBe('XFORGE_EXPLAIN_CODE_UNKNOWN');
    expect(result.json.diagnostics[0].message).toContain('Did you mean');
    expect(result.json.diagnostics[0].message).toContain('XFORGE_STAGE_BUNDLE_TREE_DIRTY');
  }, 600_000);

  it('requires a code rather than printing the whole catalogue', async () => {
    const root = await fixture();
    const result = await runCli(root, ['explain']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics[0].code).toBe('XFORGE_ARGUMENT_REQUIRED');
  }, 600_000);
});
