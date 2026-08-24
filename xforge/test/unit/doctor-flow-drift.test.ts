import { describe, expect, it, vi } from 'vitest';

/*
 * doctor is the command a person runs when the installation is already suspect, so the one check
 * that reads the npm payload must not be able to take the rest of the report down with it.
 * `loadBundledScaffold` throws -- on a missing payload, a digest mismatch, a forbidden symlink, or a
 * protocol mismatch -- and every one of those is a state in which the other findings still matter.
 *
 * Mocked in-process rather than by corrupting `scaffold/files.sha256` on disk: that file belongs to
 * this repository's own CLI package, and a test that rewrites it races every other test file.
 */
vi.mock('../../src/core/bundled-scaffold.js', () => ({
  loadBundledScaffold: vi.fn(async () => { throw new Error('Bundled Scaffold digest mismatch'); }),
}));

describe('doctor when the bundled payload cannot be read', () => {
  it('drops the Flow drift check and still reports everything else', async () => {
    const { executeDoctor } = await import('../../src/commands/doctor.js');
    const { loadProject } = await import('../../src/core/project-loader.js');
    const { fixture, updateYaml } = await import('../helpers.js');
    const root = await fixture();
    /* Drift that would otherwise be reported, so a silent pass cannot be mistaken for a match. */
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow: any) => { flow.metadata.version = 1; });

    const project = await loadProject(root, { exactRoot: true });
    const result = await executeDoctor(project, { strict: false });

    expect(result.data.suggestions.filter((item) => item.code === 'XFORGE_DOCTOR_FLOW_VERSION_DRIFT')).toEqual([]);
    expect(result.data.summary).toBeDefined();
    expect(typeof result.data.summary.dangling).toBe('number');
  });
});
