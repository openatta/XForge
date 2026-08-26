import { describe, expect, it } from 'vitest';
import { project } from '../project-builder.js';
import { runCli, write } from '../helpers.js';

/**
 * The two refusals that used to trap a Change between them.
 *
 * `governance-assets-are-integrator-only` states that the Constitution, the canonical Specs, the
 * Manifest and the Lock are written by the Integrator — so a Change that amends the Constitution has
 * to write one. Both routes into the plan were refused, and neither refusal mentioned the other:
 * declaring the path got `XFORGE_WORK_PACKAGE_SHARED_WRITE` ("no package may write it"), and not
 * declaring it but having it in the delivery's range got `XFORGE_WORK_PACKAGE_WRITE_ESCAPE`, whose
 * message invites exactly the repair the first one refuses.
 *
 * A live governance Change found the working route by making both mistakes first. Nothing is
 * loosened here — no package may write a governance asset, and that stays true — but the refusals
 * now name each other and name the route that works.
 */
describe('governance writer', () => {
  const PLAN = (writePaths: string[]) => [
    'apiVersion: xforge.dev/v1alpha1',
    'kind: WorkPackagePlan',
    'packages:',
    '  - id: wp-governance',
    '    goal: Amend the Constitution',
    '    role: integrator',
    '    depends_on: []',
    '    inputs: [xforge/changes/add-feature/design.md]',
    `    write_paths: [${writePaths.join(', ')}]`,
    '    skills: [xforge-apply]',
    '    verify:',
    `      - ["${process.execPath}", "-e", "process.exit(0)"]`,
    '    done_when: ["the amendment is recorded"]',
  ].join('\n') + '\n';

  it('refuses a declared governance path, and says where the write does belong', async () => {
    const built = await project().flow('solid').atStage('design').build();
    await write(built.root, `xforge/changes/${built.change}/work-packages.yaml`, PLAN(['"xforge/constitution.md"']));

    const result = await runCli(built.root, ['state', '--change', built.change]);
    const refusal = result.json.diagnostics.find((item: any) => item.code === 'XFORGE_WORK_PACKAGE_SHARED_WRITE');
    expect(refusal.message).toContain('xforge/constitution.md');
    /* The route, in the refusal that would otherwise send the author to the other refusal. */
    expect(refusal.message).toContain('outside every package');
    /* And the trap they actually fell into next: reserving it instead. */
    expect(refusal.message).toContain('integrator_paths');
  }, 300_000);

  it('classifies a governance asset in the delivery range as its own refusal, not a write escape', async () => {
    /*
     * The other half. Reported as an ordinary escape, the message reads "add it to write_paths" —
     * which is refused above. This one has to say that adding it is not the repair, or the two
     * diagnostics send the author back and forth.
     */
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await readFile(path.join(process.cwd(), 'src', 'core', 'work-packages.ts'), 'utf8');
    const message = /XFORGE_WORK_PACKAGE_GOVERNANCE_IN_RANGE',\s*\n\s*`([^`]*)`/.exec(source)?.[1] ?? '';
    expect(message).toContain('XFORGE_WORK_PACKAGE_SHARED_WRITE');
    expect(message).toContain('is not the repair');
    expect(message).toContain('outside every package');
  });

  it('leaves a package that writes only its own paths alone', async () => {
    /* The boundary is unchanged: nothing here loosens what a package may declare. */
    const built = await project().flow('solid').atStage('design').build();
    await write(built.root, `xforge/changes/${built.change}/work-packages.yaml`, PLAN(['"src/assembly/**"']).replace('role: integrator', 'role: worker'));

    const result = await runCli(built.root, ['state', '--change', built.change]);
    expect(result.json.diagnostics.filter((item: any) => item.code === 'XFORGE_WORK_PACKAGE_SHARED_WRITE')).toEqual([]);
    expect(result.json.diagnostics.filter((item: any) => item.code === 'XFORGE_WORK_PACKAGE_GOVERNANCE_IN_RANGE')).toEqual([]);
  }, 300_000);
});
