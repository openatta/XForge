import { describe, expect, it } from 'vitest';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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

  /**
   * A Flow that arrives as `added` rather than `changed`, which is the case the prompt did not cover.
   *
   * The Flow paragraph sits under the `changed` heading, and the `added` heading says "copy them in
   * verbatim" with no exception. `xforge/flows/**` is denied to an Agent by `protected-files`, so
   * that instruction resolves to a refused tool call -- and the `Never` list cannot rescue it,
   * because that list is derived from `inTransaction !== 'full'` and a Flow is staged and diffed
   * like everything else in its zone. Concrete trigger: any release that ships a new Flow.
   */
  it('does not tell an Agent to copy in a new Flow it is denied from writing', async () => {
    const root = await fixture();
    await rm(path.join(root, 'xforge', 'flows', 'major.yaml'), { force: true });

    const staged = await runCli(root, ['upgrade-scaffold']);
    expect(staged.code, JSON.stringify(staged.json?.diagnostics)).toBe(0);
    const entry = (staged.json.data.plan.entries as any[]).find((item) => item.path === 'xforge/flows/major.yaml');
    expect(entry?.disposition, 'the Flow was not classified as new').toBe('added');

    const prompt = await readFile(path.join(root, 'xforge', '.upgrade', 'MERGE.md'), 'utf8');
    const newSection = prompt.slice(prompt.indexOf('file(s) are new'));
    expect(newSection).toContain('xforge/flows/major.yaml');
    /* Named in the section that carries the instruction, not only in the one about changed files. */
    expect(newSection.slice(0, newSection.indexOf('## Never'))).toContain('protected-files');
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

  it('keeps its working state in one dotdir and announces it in a visible file', async () => {
    const root = await agedProject();
    const staged = (await runCli(root, ['upgrade-scaffold'])).json.data.staged;
    expect(staged).toBe('xforge/.upgrade/incoming');

    const working = await tree(root, 'xforge/.upgrade');
    expect([...working.keys()]).toEqual(expect.arrayContaining(['MERGE.md', 'plan.json', 'plan.md', '.gitignore']));
    /* The prompt has to name the files, or handing it to an Agent restores the survey it replaces. */
    expect(working.get('MERGE.md')).toContain('gates/unit-tests.yaml');
    expect(working.get('MERGE.md')).toContain('xforge/.upgrade/snapshot');
    /* Neither the snapshot nor the staged release belongs in the history: one duplicates the commit
       this was staged from, the other a published package. */
    expect(working.get('.gitignore')).toContain('*');

    /*
     * The dotdir gives up the visibility the old `xforge/scaffold-<version>/` had, so the marker
     * carries it instead -- and carries it to a better reader. Whoever staged the upgrade knows they
     * staged it; the person who needs telling is running `transition` three commands later.
     */
    const marker = await readFile(path.join(root, 'xforge', 'UPGRADING.md'), 'utf8');
    expect(marker).toContain('upgrade-scaffold --complete');
    expect(marker).toContain('upgrade-scaffold --rollback');

    const state = await runCli(root, ['state']);
    expect(state.json.diagnostics.some((item: any) => item.code === 'XFORGE_UPGRADE_IN_PROGRESS')).toBe(true);
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
    /* Closed means closed: the marker every other command reads goes with the working state. */
    expect(await readFile(path.join(root, 'xforge', 'UPGRADING.md'), 'utf8').catch(() => null)).toBe(null);

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

    /*
     * An older CLI's snapshot, reproduced — and reproduced in that CLI's *layout*, which is the part
     * that makes it reachable. A record at `xforge/.upgrade/state.json` was written by this version,
     * and this version records every managed tree, so a `before` map missing one is not a state any
     * run can reach: it now reads as "the merge added that tree", which is the opposite reading and
     * the one that deletes. Only a record in the pre-`.upgrade/` shape is genuinely ambiguous, and
     * only there is leaving the tree alone the right answer.
     */
    const upgrade = path.join(root, 'xforge', '.upgrade');
    const record = JSON.parse(await readFile(path.join(upgrade, 'state.json'), 'utf8'));
    for (const key of ['before', 'after'] as const) {
      if (!record[key]) continue;
      record[key] = Object.fromEntries(Object.entries(record[key]).filter(([p]) => !p.startsWith('xforge/flows/')));
    }
    await mkdir(path.join(root, 'xforge', '.rollback'), { recursive: true });
    await cp(path.join(upgrade, 'snapshot'), path.join(root, 'xforge', '.rollback', `scaffold-${record.fromVersion}`), { recursive: true });
    await rm(path.join(root, 'xforge', '.rollback', `scaffold-${record.fromVersion}`, 'flows'), { recursive: true, force: true });
    await writeFile(path.join(root, 'xforge', '.rollback', 'manifest.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rm(upgrade, { recursive: true, force: true });

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

/*
 * The commit underneath the snapshot.
 *
 * The snapshot is the route back and it needs no Git at all, which is why it stays the primary
 * path. What it cannot survive is somebody deleting or editing it, so `stage` also records a commit
 * -- the copy that lives somewhere else. A commit is only a restore point for what was actually in
 * it, so a HEAD recorded over uncommitted work would name a state the project was never in, and
 * offering that as a fallback would hand someone a command that silently discards what they had not
 * committed. Hence a refusal rather than a warning, and hence three distinct outcomes rather than
 * two: committed, uncommitted, and no repository to ask.
 */
describe('the commit backstop', () => {
  const git = (root: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd: root, encoding: 'utf8' });

  async function committedProject(): Promise<string> {
    const root = await fixture();
    git(root, 'init', '--quiet');
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'fixture');
    return root;
  }

  it('records the commit as a restore point, and names it when a rollback undoes the merge', async () => {
    const root = await committedProject();
    expect((await runCli(root, ['upgrade-scaffold'])).code).toBe(0);

    const record = JSON.parse(await readFile(path.join(root, 'xforge', '.upgrade', 'state.json'), 'utf8'));
    expect(record.gitClean).toBe(true);
    expect(record.gitHead).toMatch(/^[0-9a-f]{40}$/);

    const back = await runCli(root, ['upgrade-scaffold', '--rollback']);
    expect(back.code).toBe(0);
    const backstop = back.json.diagnostics.find((item: any) => item.code === 'XFORGE_UPGRADE_ROLLBACK_BACKSTOP');
    /* The command is printed, never run: restoring from the snapshot has already happened by the
       time anyone reads this, and overwriting a working tree from Git is somebody's decision. */
    expect(backstop.message).toContain(`git restore --source=${record.gitHead}`);
    expect(backstop.message).toContain('xforge/scaffold xforge/flows xforge/scripts xforge/manifest.yaml');
    expect(backstop.severity).toBe('info');
  });

  it('refuses to stage over uncommitted managed work, and says which files', async () => {
    const root = await committedProject();
    const gate = scaffold(root, 'gates', 'unit-tests.yaml');
    await writeFile(gate, `${await readFile(gate, 'utf8')}\n# edited and not committed\n`, 'utf8');

    const refused = await runCli(root, ['upgrade-scaffold']);
    expect(refused.code).not.toBe(0);
    expect(refused.json.diagnostics[0].code).toBe('XFORGE_UPGRADE_UNCOMMITTED');
    expect(refused.json.diagnostics[0].message).toContain('xforge/scaffold/gates/unit-tests.yaml');
    /* Refused means refused: nothing staged, nothing snapshotted. */
    expect((await tree(root, 'xforge/.rollback')).size).toBe(0);
  });

  it('leaves work outside the managed paths alone, because it is not what a rollback would overwrite', async () => {
    const root = await committedProject();
    await mkdir(path.join(root, 'xforge', 'changes', 'in-flight'), { recursive: true });
    await writeFile(path.join(root, 'xforge', 'changes', 'in-flight', 'notes.md'), 'uncommitted\n', 'utf8');

    /* An open Change is its own refusal, so this asks the narrower question the gate is for: the
       uncommitted file under `xforge/changes/` must not be the reason. */
    const staged = await runCli(root, ['upgrade-scaffold', '--with-active-changes']);
    expect(staged.json.diagnostics.some((item: any) => item.code === 'XFORGE_UPGRADE_UNCOMMITTED')).toBe(false);
    expect(staged.code).toBe(0);
  });

  it('stages without a restore point when told to, and says the snapshot is now the only way back', async () => {
    const root = await committedProject();
    const gate = scaffold(root, 'gates', 'unit-tests.yaml');
    await writeFile(gate, `${await readFile(gate, 'utf8')}\n# edited and not committed\n`, 'utf8');

    const staged = await runCli(root, ['upgrade-scaffold', '--allow-dirty']);
    expect(staged.code).toBe(0);
    const accepted = staged.json.diagnostics.find((item: any) => item.code === 'XFORGE_UPGRADE_UNCOMMITTED_ACCEPTED');
    expect(accepted.severity).toBe('warning');

    const record = JSON.parse(await readFile(path.join(root, 'xforge', '.upgrade', 'state.json'), 'utf8'));
    expect(record.gitClean).toBe(false);
    /* A HEAD exists and is still recorded — it is the span's other end in the upgrade log — but
       `gitClean: false` is what stops it being offered as somewhere to go back to. */
    const back = await runCli(root, ['upgrade-scaffold', '--rollback']);
    expect(back.json.diagnostics.some((item: any) => item.code === 'XFORGE_UPGRADE_ROLLBACK_BACKSTOP')).toBe(false);
  });

  it('stages a project that is not a Git working tree at all, on the snapshot alone', async () => {
    const root = await fixture();
    const staged = await runCli(root, ['upgrade-scaffold']);
    expect(staged.code).toBe(0);
    expect(staged.json.diagnostics.some((item: any) => item.code === 'XFORGE_UPGRADE_UNCOMMITTED')).toBe(false);

    const record = JSON.parse(await readFile(path.join(root, 'xforge', '.upgrade', 'state.json'), 'utf8'));
    expect(record.gitClean).toBe(false);
    expect(record.gitHead).toBe(null);
  });
});

/*
 * The layout moved, and a project can be holding an upgrade staged in the previous one: stage on the
 * older CLI, install this one, then finish or abandon. Refusing that project would strand it between
 * two Scaffolds with the merge already half done, so `complete` and `rollback` read both shapes.
 * `stage` only ever writes the new one.
 */
describe('an upgrade staged in the pre-.upgrade layout', () => {
  /** Reshapes a freshly staged upgrade into what a CLI before this release would have written. */
  async function asLegacyLayout(root: string, toVersion: string): Promise<string> {
    const upgrade = path.join(root, 'xforge', '.upgrade');
    const record = JSON.parse(await readFile(path.join(upgrade, 'state.json'), 'utf8'));
    await mkdir(path.join(root, 'xforge', '.rollback'), { recursive: true });
    await cp(path.join(upgrade, 'snapshot'), path.join(root, 'xforge', '.rollback', `scaffold-${record.fromVersion}`), { recursive: true });
    await cp(path.join(upgrade, 'incoming'), path.join(root, 'xforge', `scaffold-${toVersion}`), { recursive: true });
    /* The plan documents lived inside the staged directory before they were lifted out of it. */
    for (const name of ['plan.json', 'plan.md', 'MERGE.md']) {
      await cp(path.join(upgrade, name), path.join(root, 'xforge', `scaffold-${toVersion}`, name));
    }
    await writeFile(path.join(root, 'xforge', '.rollback', 'manifest.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rm(upgrade, { recursive: true, force: true });
    return String(record.fromVersion);
  }

  it('refuses to stage over one, instead of deleting the snapshot it cannot see', async () => {
    const root = await agedProject();
    const toVersion = (await runCli(root, ['upgrade-scaffold'])).json.data.plan.toVersion;
    const fromVersion = await asLegacyLayout(root, toVersion);

    /*
     * The guard used to read `xforge/.upgrade/incoming/` alone, so this answered "no upgrade in
     * progress" — and staging clears the snapshot root before anything else, which deleted the only
     * copy of the pre-upgrade Scaffold and took a fresh snapshot of the half-merged trees. Exit 0,
     * no diagnostic, and nothing left to roll back to.
     */
    const again = await runCli(root, ['upgrade-scaffold']);
    expect(again.code).not.toBe(0);
    expect(again.json.diagnostics[0].code).toBe('XFORGE_UPGRADE_ALREADY_STAGED');
    expect((await tree(root, `xforge/.rollback/scaffold-${fromVersion}`)).size).toBeGreaterThan(0);
  });

  it('completes one in place, reading the plan from where that layout put it', async () => {
    const root = await agedProject();
    const toVersion = (await runCli(root, ['upgrade-scaffold'])).json.data.plan.toVersion;
    await asLegacyLayout(root, toVersion);

    const done = await runCli(root, ['upgrade-scaffold', '--complete']);
    expect(done.code).toBe(0);
    /* An unreadable plan is indistinguishable from a plan that raised no files, so an empty adoption
       report here would be a silent wrong answer rather than a failure. */
    expect(done.json.data.adoption.notMatching).toContain('xforge/scaffold/gates/unit-tests.yaml');
    expect((await tree(root, `xforge/scaffold-${toVersion}`)).size).toBe(0);
  });

  it('rolls one back, and leaves a tree that layout could not have snapshotted alone', async () => {
    const root = await agedProject();
    const toVersion = (await runCli(root, ['upgrade-scaffold'])).json.data.plan.toVersion;
    const fromVersion = await asLegacyLayout(root, toVersion);
    /* Its snapshot predates `xforge/scripts/` being managed, so nothing can say whether the tree on
       disk is the project's own or the merge's — and deleting on that guess is the destructive one. */
    await rm(path.join(root, 'xforge', '.rollback', `scaffold-${fromVersion}`, 'scripts'), { recursive: true, force: true });

    const back = await runCli(root, ['upgrade-scaffold', '--rollback']);
    expect(back.code).toBe(0);
    const uncovered = back.json.diagnostics.find((item: any) => item.code === 'XFORGE_UPGRADE_ROLLBACK_TREE_UNCOVERED');
    expect(uncovered.message).toContain('xforge/scripts/');
    expect((await tree(root, 'xforge/scripts')).size).toBeGreaterThan(0);
    expect((await tree(root, 'xforge/.rollback')).size).toBe(0);
  });
});

describe('a managed tree the merge brought in', () => {
  it('is removed by a rollback, rather than surviving the merge that added it', async () => {
    const root = await agedProject();
    /* An older project with no Scripts at all: the snapshot will hold none, and until the record was
       consulted the rollback read that as "this snapshot is too old to say" and left the tree. */
    await rm(path.join(root, 'xforge', 'scripts'), { recursive: true, force: true });
    await updateYaml(root, 'xforge/manifest.yaml', (manifest: any) => { manifest.scripts = []; });

    await runCli(root, ['upgrade-scaffold']);
    await cp(path.join(root, 'xforge', '.upgrade', 'incoming', 'scripts'), path.join(root, 'xforge', 'scripts'), { recursive: true });
    expect((await tree(root, 'xforge/scripts')).size).toBeGreaterThan(0);

    const back = await runCli(root, ['upgrade-scaffold', '--rollback']);
    expect(back.code).toBe(0);
    /*
     * `before` recorded no files there, so the tree standing now arrived in the merge and removing it
     * *is* the restore. Leaving it mattered most for `xforge/flows/`, where `loadFlows` reads every
     * `.yaml` in the directory regardless of what the Manifest selects — an abandoned merge's Flow
     * stayed live against work that had rolled back to a Scaffold never mentioning it.
     */
    expect((await tree(root, 'xforge/scripts')).size).toBe(0);
    expect(back.json.diagnostics.some((item: any) => item.code === 'XFORGE_UPGRADE_ROLLBACK_TREE_UNCOVERED')).toBe(false);
  });
});

describe('the plan documents', () => {
  it('do not outlive the upgrade that produced them', async () => {
    const root = await agedProject();
    await runCli(root, ['upgrade-scaffold']);
    await runCli(root, ['upgrade-scaffold', '--complete']);

    /*
     * The Skill's first instruction is to read `xforge/.upgrade/MERGE.md`, so a prompt left behind by
     * a closed upgrade is not inert: it describes a merge that already happened and points at an
     * `incoming/` that no longer exists.
     */
    const working = await tree(root, 'xforge/.upgrade');
    expect([...working.keys()]).not.toEqual(expect.arrayContaining(['MERGE.md', 'plan.json', 'plan.md']));
    /* The snapshot and the record stay: the rollback point outlives the merge on purpose. */
    expect(working.has('state.json')).toBe(true);
  });
});

describe('a merge that leaves the project unprojectable', () => {
  it('records the upgrade as complete and says plainly that the targets did not move', async () => {
    const root = await agedProject();
    /* Installed first: with no installation record there is no projection to replay, and this is
       about the case where there is one and it cannot be written. */
    expect((await runCli(root, ['install'])).code).toBe(0);
    await runCli(root, ['upgrade-scaffold']);
    /* A merge that removed a Skill the Manifest still selects — the projection has an error to
       report and writes nothing, while the merge itself is already adopted on disk. */
    await rm(scaffold(root, 'skills', 'xforge-propose'), { recursive: true, force: true });

    const done = await runCli(root, ['upgrade-scaffold', '--complete']);
    /*
     * The reprojection is skipped, not faked. `executeProjection` returns the plan it would have
     * applied even when it refuses to write, so splicing those changes in under "reprojected every
     * target" reported files as created that were never written — the two things a reader checks to
     * decide whether the state on disk can be trusted.
     */
    expect(done.json.diagnostics.some((item: any) => item.code === 'XFORGE_UPGRADE_REPROJECTION_SKIPPED')).toBe(true);
    expect(done.json.changes.some((item: any) => String(item.path).startsWith('.claude/'))).toBe(false);
    /* The projection reported its own errors too, so the envelope is not ok — which is the honest
       answer. What must not happen is a green envelope over targets that never moved. */
    expect(done.code).not.toBe(0);
    /* The upgrade still closed: the merge happened, and a record that denied it would be the lie in
       the other direction. */
    const record = JSON.parse(await readFile(path.join(root, 'xforge', '.upgrade', 'state.json'), 'utf8'));
    expect(record.completedAt).not.toBe(null);
  });
});
