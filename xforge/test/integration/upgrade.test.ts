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

/*
 * Flows are managed now, and this is the case that was structurally impossible before.
 *
 * `xforge/flows/` sits beside `xforge/scaffold/` rather than inside it, and the upgrade read only
 * the second, so a Flow was never brought, never diffed, and never mentioned. A project ran
 * whatever Flow it was initialised with for as long as it existed while the upgrade log reported
 * that every file the plan named now matched -- true, of a plan that could not name it. One team
 * completed an entire Major three releases behind its own toolchain and found out by reading the
 * npm payload by hand.
 *
 * Bringing it is still not adopting it. A Flow says how many approvals a Stage needs and where a
 * blocker sends the work back; the upgrade stages the incoming copy and the project decides.
 */
describe('staging an upgrade that changes a Flow', () => {
  it('classifies a drifted Flow and stages the incoming one without touching the project copy', async () => {
    const root = await fixture();
    const flowPath = path.join(root, 'xforge', 'flows', 'solid.yaml');
    const original = await readFile(flowPath, 'utf8');
    /* An older Flow, the shape every project initialised before a Flow moved actually has. */
    await writeFile(flowPath, original.replace(/^  version: \d+$/m, '  version: 1'), 'utf8');

    const staged = await runCli(root, ['upgrade-scaffold']);
    expect(staged.code, JSON.stringify(staged.json?.diagnostics)).toBe(0);

    const entry = (staged.json.data.plan.entries as any[]).find((item) => item.path === 'xforge/flows/solid.yaml');
    expect(entry, 'the plan never mentioned the Flow').toBeDefined();
    expect(entry.disposition).toBe('changed');

    /* Staged copies mirror their destination, so where each one belongs is readable from its path. */
    const stagedRoot = staged.json.data.staged;
    expect(await readFile(path.join(root, ...stagedRoot.split('/'), 'flows', 'solid.yaml'), 'utf8'))
      .not.toContain('  version: 1');

    /* And the project's own Flow is untouched until somebody merges it. */
    expect(await readFile(flowPath, 'utf8')).toContain('  version: 1');
  });

  it('reports a Flow the project does not declare rather than adopting it', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest: any) => {
      manifest.scaffold.flows = manifest.scaffold.flows.filter((id: string) => id !== 'major');
    });

    const staged = await runCli(root, ['upgrade-scaffold']);
    expect(staged.code).toBe(0);
    const unselected = (staged.json.data.plan.unselected as any[]).filter((item) => item.kind === 'flow');
    expect(unselected.map((item) => item.id)).toEqual(['major']);
    expect(unselected[0].path).toBe('xforge/flows/major.yaml');
  });
});

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

  /*
   * The tree the restore loop cannot repair on its own.
   *
   * Restoring writes back the files the snapshot holds, so a file the merge *added* — never in the
   * snapshot — survives it. That was harmless for `xforge/scaffold/` only because the delete before
   * the loop covered that tree; `xforge/flows/` had no such delete, and a Flow left behind there is
   * not inert. `loadFlows` reads every `.yaml` in the directory rather than the Manifest's
   * selection, and `flowEligibilityDiagnostics` measures each Change against every Flow declaring
   * `policy.requiredWhen` — so an orphan can demand a Flow of work that rolled back to a Scaffold
   * which never mentioned it.
   */
  it('clears an adopted Flow the snapshot never held, in both trees', async () => {
    const root = await agedProject();
    const flowsBefore = await tree(root, 'xforge/flows');
    await runCli(root, ['upgrade-scaffold']);
    /* What a merge does with a `added` Flow: copies it in. The Manifest is deliberately not told,
       which is exactly why nothing else would ever notice the file again. */
    await writeFile(path.join(root, 'xforge', 'flows', 'adopted.yaml'), 'apiVersion: xforge.dev/v1alpha2\n', 'utf8');
    await mkdir(scaffold(root, 'skills', 'xforge-architect'), { recursive: true });
    await writeFile(scaffold(root, 'skills', 'xforge-architect', 'SKILL.md'), 'adopted', 'utf8');
    await runCli(root, ['upgrade-scaffold', '--complete']);

    expect((await runCli(root, ['upgrade-scaffold', '--rollback'])).code).toBe(0);
    expect(same(flowsBefore, await tree(root, 'xforge/flows'))).toBe(true);
  });

  /* The same survivor, on the path that reaches it without a completed upgrade: before `complete`
     there is no `after` baseline, so the drift guard compares nothing and lets the rollback run. */
  it('clears it on an abandoned upgrade too, where the drift guard has no baseline', async () => {
    const root = await agedProject();
    const flowsBefore = await tree(root, 'xforge/flows');
    await runCli(root, ['upgrade-scaffold']);
    await writeFile(path.join(root, 'xforge', 'flows', 'adopted.yaml'), 'apiVersion: xforge.dev/v1alpha2\n', 'utf8');

    expect((await runCli(root, ['upgrade-scaffold', '--rollback'])).code).toBe(0);
    expect(same(flowsBefore, await tree(root, 'xforge/flows'))).toBe(true);
  });

  /*
   * The reason the fix is not a symmetric delete.
   *
   * Every published CLI up to 0.7.18 snapshotted `xforge/scaffold/` alone, and a project can be
   * holding one: stage an upgrade there, install this CLI, roll back. Deleting a tree the snapshot
   * cannot restore would take the project's whole governance definition with nothing to put back —
   * strictly worse than the leftover file the fix exists to prevent. So an uncovered tree is left
   * standing, and said out loud.
   */
  it('refuses an older-shaped snapshot outright, and spares the uncovered tree when forced past it', async () => {
    const root = await agedProject();
    await runCli(root, ['upgrade-scaffold']);
    await runCli(root, ['upgrade-scaffold', '--complete']);
    const flowsNow = await tree(root, 'xforge/flows');
    expect(flowsNow.size).toBeGreaterThan(0);

    /* An older CLI's snapshot, reproduced: the flows half removed from both the directory and the
       digest maps that decide whether a rollback is safe. */
    const snapshot = (await readdir(path.join(root, 'xforge', '.rollback')))
      .find((name) => name.startsWith('scaffold-'))!;
    await rm(path.join(root, 'xforge', '.rollback', snapshot, 'flows'), { recursive: true, force: true });
    const manifestPath = path.join(root, 'xforge', '.rollback', 'manifest.json');
    const record = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const key of ['before', 'after'] as const) {
      if (!record[key]) continue;
      record[key] = Object.fromEntries(Object.entries(record[key]).filter(([p]) => !p.startsWith('xforge/flows/')));
    }
    await writeFile(manifestPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    /* The first line of defence, and it turns out to be the drift guard rather than anything added
       for this: `currentManaged` reads a flows tree the trimmed `after` never recorded, so every
       file in it counts as work done since, and the rollback is refused before any delete runs. */
    const refused = await runCli(root, ['upgrade-scaffold', '--rollback']);
    expect(refused.code).not.toBe(0);
    expect(refused.json.diagnostics[0].code).toBe('XFORGE_UPGRADE_ROLLBACK_DRIFT');

    /* The second line, which is the one that matters: `--force` exists precisely to walk past that
       refusal, and past it the delete would have taken a tree nothing could put back. */
    const back = await runCli(root, ['upgrade-scaffold', '--rollback', '--force']);
    expect(back.code).toBe(0);
    expect(same(flowsNow, await tree(root, 'xforge/flows'))).toBe(true);
    expect(back.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_UPGRADE_ROLLBACK_TREE_UNCOVERED');
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
