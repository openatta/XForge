import { describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, runCli, updateYaml } from '../helpers.js';

const scaffold = (root: string, ...rest: string[]) => path.join(root, 'xforge', 'scaffold', ...rest);

async function tree(root: string, relative: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, `${prefix}${entry.name}/`);
      else files.set(`${prefix}${entry.name}`, await readFile(absolute, 'utf8'));
    }
  };
  await walk(path.join(root, ...relative.split('/')), '');
  return files;
}

const same = (left: Map<string, string>, right: Map<string, string>) =>
  left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);

/**
 * A project that adapted a shipped Gate — the shape this whole feature exists for.
 *
 * XOps did exactly this: its `unit-tests` Gate opens "This project's real test command, replacing
 * the shipped npm placeholder". A fixture without that adaptation cannot fail the way a real
 * project fails, so it cannot test whether the upgrade preserves one.
 */
async function agedProject(): Promise<string> {
  const root = await fixture();
  await rm(scaffold(root, 'skills', 'xforge-architect'), { recursive: true, force: true });
  const gate = scaffold(root, 'gates', 'unit-tests.yaml');
  await writeFile(gate, `${await readFile(gate, 'utf8')}\n# This project's real test command.\n`, 'utf8');
  await updateYaml(root, 'xforge/manifest.yaml', (manifest: any) => {
    manifest.scaffold.skills = manifest.scaffold.skills.filter((id: string) => id !== 'xforge-architect');
  });
  return root;
}

describe('staging an upgrade', () => {
  it('classifies the Scaffold and writes nothing into it', async () => {
    const root = await agedProject();
    const before = await tree(root, 'xforge/scaffold');

    const staged = await runCli(root, ['upgrade-scaffold']);
    expect(staged.code).toBe(0);

    /*
     * The load-bearing property. Everything downstream — the merge, the rollback, the refusal to
     * adopt on the project's behalf — rests on the live Scaffold being untouched until a person or
     * an Agent decides. A staging step that edited it would make the rollback point a fiction.
     */
    expect(same(before, await tree(root, 'xforge/scaffold'))).toBe(true);

    const plan = staged.json.data.plan;
    expect(plan.counts.changed).toBeGreaterThan(0);
    expect(plan.counts.added).toBeGreaterThan(0);
    expect(plan.entries.find((entry: any) => entry.path.endsWith('gates/unit-tests.yaml')).disposition).toBe('changed');
    expect(plan.unselected.some((asset: any) => asset.id === 'xforge-architect')).toBe(true);
  });

  it('leaves a visible directory carrying the plan and the merge prompt', async () => {
    const root = await agedProject();
    const staged = (await runCli(root, ['upgrade-scaffold'])).json.data.staged;
    /* Visible, not a dotfile: an unfinished upgrade should be obvious in a plain file listing. */
    expect(staged.startsWith('xforge/scaffold-')).toBe(true);

    const contents = await tree(root, staged);
    expect([...contents.keys()]).toEqual(expect.arrayContaining(['MERGE.md', 'plan.json', 'plan.md']));
    /* The prompt has to name the files, or handing it to an Agent restores the survey it replaces. */
    expect(contents.get('MERGE.md')).toContain('gates/unit-tests.yaml');
    expect(contents.get('MERGE.md')).toContain('xforge/.rollback');
  });

  it('refuses while a Change is open, and says which', async () => {
    const root = await agedProject();
    await mkdir(path.join(root, 'xforge', 'changes', 'in-flight'), { recursive: true });

    const refused = await runCli(root, ['upgrade-scaffold']);
    expect(refused.code).not.toBe(0);
    expect(refused.json.diagnostics[0].code).toBe('XFORGE_UPGRADE_ACTIVE_CHANGES');
    /* Naming it is the point: the person deciding needs to know what they would be disrupting. */
    expect(refused.json.diagnostics[0].message).toContain('in-flight');

    const accepted = await runCli(root, ['upgrade-scaffold', '--with-active-changes']);
    expect(accepted.code).toBe(0);
    expect(accepted.json.diagnostics.some((item: any) => item.code === 'XFORGE_UPGRADE_ACTIVE_CHANGES_ACCEPTED')).toBe(true);
  });

  it('refuses to stage twice over an unfinished merge', async () => {
    const root = await agedProject();
    await runCli(root, ['upgrade-scaffold']);
    const again = await runCli(root, ['upgrade-scaffold']);
    expect(again.json.diagnostics[0].code).toBe('XFORGE_UPGRADE_ALREADY_STAGED');
  });

  it('writes nothing at all on --dry-run', async () => {
    const root = await agedProject();
    const before = await tree(root, 'xforge');
    const dry = await runCli(root, ['upgrade-scaffold', '--dry-run']);
    expect(dry.json.data.plan.counts.changed).toBeGreaterThan(0);
    expect(same(before, await tree(root, 'xforge'))).toBe(true);
  });
});

describe('completing an upgrade', () => {
  it('clears the staged directory and records what the merge kept', async () => {
    const root = await agedProject();
    const staged = (await runCli(root, ['upgrade-scaffold'])).json.data.staged;
    /* A merge that adopts the new Skill and keeps the project's own Gate — the intended outcome. */
    const incoming = await tree(root, `${staged}/skills/xforge-architect`);
    await mkdir(scaffold(root, 'skills', 'xforge-architect'), { recursive: true });
    for (const [name, content] of incoming) await writeFile(scaffold(root, 'skills', 'xforge-architect', name), content, 'utf8');

    const done = await runCli(root, ['upgrade-scaffold', '--complete']);
    expect(done.code).toBe(0);
    expect((await tree(root, staged)).size).toBe(0);

    /*
     * The Gate the project adapted is reported as kept, not as failed. Whether a project should
     * have taken the newer file is a question about its intent that no digest can answer, so the
     * log states what is true and leaves the judgement to whoever reads it.
     */
    expect(done.json.data.adoption.notMatching).toContain('xforge/scaffold/gates/unit-tests.yaml');
    const log = await readFile(path.join(root, 'xforge', 'upgrade-log.md'), 'utf8');
    expect(log).toContain('gates/unit-tests.yaml');
  });
});

describe('rolling back', () => {
  it('restores the previous Scaffold byte for byte', async () => {
    const root = await agedProject();
    const before = await tree(root, 'xforge/scaffold');
    await runCli(root, ['upgrade-scaffold']);
    await mkdir(scaffold(root, 'skills', 'xforge-architect'), { recursive: true });
    await writeFile(scaffold(root, 'skills', 'xforge-architect', 'SKILL.md'), 'adopted', 'utf8');
    await runCli(root, ['upgrade-scaffold', '--complete']);

    const back = await runCli(root, ['upgrade-scaffold', '--rollback']);
    expect(back.code).toBe(0);
    expect(same(before, await tree(root, 'xforge/scaffold'))).toBe(true);
  });

  it('refuses when work has happened since, rather than discarding it', async () => {
    const root = await agedProject();
    await runCli(root, ['upgrade-scaffold']);
    await runCli(root, ['upgrade-scaffold', '--complete']);

    const gate = scaffold(root, 'gates', 'structure.yaml');
    await writeFile(gate, `${await readFile(gate, 'utf8')}\n# later work\n`, 'utf8');

    const refused = await runCli(root, ['upgrade-scaffold', '--rollback']);
    expect(refused.code).not.toBe(0);
    expect(refused.json.diagnostics[0].code).toBe('XFORGE_UPGRADE_ROLLBACK_DRIFT');
    /* An escape hatch exists, because sometimes discarding it is exactly what is wanted. */
    expect((await runCli(root, ['upgrade-scaffold', '--rollback', '--force'])).code).toBe(0);
  });

  it('refuses when there is nothing to roll back to', async () => {
    const root = await agedProject();
    const refused = await runCli(root, ['upgrade-scaffold', '--rollback']);
    expect(refused.json.diagnostics[0].code).toBe('XFORGE_UPGRADE_NO_ROLLBACK');
  });

  it('keeps the upgrade log, because a rollback is also history', async () => {
    const root = await agedProject();
    await runCli(root, ['upgrade-scaffold']);
    await runCli(root, ['upgrade-scaffold', '--complete']);
    await runCli(root, ['upgrade-scaffold', '--rollback']);
    /* Erasing the record of an upgrade because it was undone would leave a project unable to say
       what it had tried. The snapshot is a mechanism; the log is an account. */
    expect(await readFile(path.join(root, 'xforge', 'upgrade-log.md'), 'utf8')).toContain('→');
  });
});
