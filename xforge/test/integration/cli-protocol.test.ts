import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCompleteSolidChange, fixture, runCli, updateYaml, yamlFile } from '../helpers.js';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

describe('CLI protocol', () => {
  it('emits exactly one JSON document on stdout and nothing on stderr', async () => {
    const root = await fixture();
    for (const args of [['state'], ['install', '--dry-run'], ['check']] as string[][]) {
      const result = await runCli(root, args);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({ protocolVersion: '2', command: args[0], root, diagnostics: expect.any(Array), changes: expect.any(Array), nextActions: expect.any(Array) });
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(result.stdout.trim().endsWith('}')).toBe(true);
    }
  });

  it('keeps text mode execution and status semantics aligned with JSON', async () => {
    const root = await fixture();
    const json = await runCli(root, ['state']);
    const text = await runCli(root, ['state', '--text']);
    expect(text.code).toBe(json.code);
    expect(text.stdout).toContain(`XForge state: ${json.json.ok ? 'OK' : 'FAILED'}`);
    expect(text.stdout).toContain(`Root: ${root}`);
    expect(text.stderr).toBe('');
  });

  it('exposes help/version without a project and rejects unknown commands', async () => {
    const root = await fixture();
    const help = await runCli(root, ['help', 'sync']);
    expect(help.code).toBe(0);
    expect(help.json.root).toBeNull();
    expect(help.json.data.commandHelp.usage).toContain('xforge');
    expect(help.json.data.commandHelp.usage).toContain('sync');
    const version = await runCli(root, ['version']);
    expect(version.code).toBe(0);
    expect(version.json.data).toMatchObject({ name: '@xforge/cli', version: '0.7.18', protocolVersion: '2' });

    const result = await runCli(root, ['frobnicate']);
    expect(result.code).toBe(1);
    expect(result.json.command).toBe('frobnicate');
    expect(result.json.diagnostics[0].code).toBe('XFORGE_COMMAND_UNKNOWN');
  });

  /*
   * `nextActions` used to stamp `authority: 'planning-write'` on every create-artifact Action, so a
   * check-stage Artifact was advertised under the wrong authority while its Stage declares
   * assurance-write. The Stage Skills tell the Agent to match an Action's authority before acting on
   * it, which against a constant is not a match at all. The value now comes from the Flow Stage that
   * produces the Artifact.
   */
  it('reads a create-artifact Action authority from the Stage that produces the Artifact', async () => {
    async function nextArtifactAction(remove: string[]): Promise<any> {
      const root = await fixture();
      await createCompleteSolidChange(root);
      for (const relative of remove) await rm(path.join(root, 'xforge', 'changes', 'add-feature', relative));
      expect((await runCli(root, ['install'])).code).toBe(0);
      const state = await runCli(root, ['state', '--change', 'add-feature']);
      return state.json.nextActions.find((item: any) => item.action === 'create-artifact');
    }

    const planning = await nextArtifactAction(['design.md', 'check-report.md']);
    expect(planning).toMatchObject({ id: 'design', authority: 'planning-write' });

    /* Same Action shape, same Flow, different Stage — so a different authority. */
    const assurance = await nextArtifactAction(['check-report.md']);
    expect(assurance).toMatchObject({ id: 'check-report', authority: 'assurance-write' });
  });

  it('reports Portable state and blocks writes when CLI identity mismatches', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.xforge.version = '9.9.9'; });
    const state = await runCli(root, ['state']);
    expect(state.code).toBe(1);
    expect(state.json.data.project.compatibility.mode).toBe('portable');
    expect(state.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CLI_IDENTITY_MISMATCH');
    const install = await runCli(root, ['install']);
    expect(install.code).toBe(1);
    expect(install.json.changes).toEqual([]);
    expect(install.json.nextActions[0].action).toBe('resolve-declared-xforge');
  });

  it('rejects the removed Git-source CLI identity', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.xforge = { source: 'git', repository: 'https://example.test/xforge.git', commit: '0123456789abcdef0123456789abcdef01234567', path: 'xforge', protocol: '2' };
    });
    const result = await runCli(root, ['state']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_SCHEMA_INVALID');
  });

  it('lets update reconcile an older-but-Protocol-compatible declared CLI version, never install/check/sync', async () => {
    const root = await fixture();
    /* `update` (unlike `install`) requires an existing installation record, so this simulates a
       real upgrade: install cleanly at the current version first, then roll the declared version
       back to simulate a project whose Manifest lagged behind the CLI it's now running under. */
    const initialInstall = await runCli(root, ['install']);
    expect(initialInstall.code, JSON.stringify(initialInstall.json.diagnostics)).toBe(0);
    /* `updateYaml` round-trips through the `yaml` library with `sortMapEntries: true`, so this
       also exercises reconcileDeclaredCliVersion's key-order independence (see project-loader.ts) —
       not just the happy-path field values. */
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.xforge.version = '0.7.7';
      manifest.scaffold.version = '0.7.7';
      manifest.scaffold.source.version = '0.7.7';
    });

    const blockedInstall = await runCli(root, ['install']);
    expect(blockedInstall.code).toBe(1);
    expect(blockedInstall.json.nextActions[0]).toMatchObject({ action: 'resolve-declared-xforge', command: ['xforge', 'update'] });

    const blockedCheck = await runCli(root, ['check']);
    expect(blockedCheck.code).toBe(1);

    const dryRun = await runCli(root, ['update', '--dry-run']);
    expect(dryRun.code).toBe(0);
    expect(dryRun.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: 'xforge/manifest.yaml' }));
    const stillOld = await readFile(path.join(root, 'xforge', 'manifest.yaml'), 'utf8');
    expect(stillOld).toContain('0.7.7');

    const update = await runCli(root, ['update']);
    expect(update.code, JSON.stringify(update.json.diagnostics)).toBe(0);
    expect(update.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: 'xforge/manifest.yaml', source: 'xforge:declared-version-upgrade:0.7.7->0.7.18' }));
    const manifest = await yamlFile(root, 'xforge/manifest.yaml');
    expect(manifest.xforge.version).toBe('0.7.18');
    /* Only the CLI pin. The Scaffold's version follows the Scaffold's content, which `update` does
       not merge — see reconcileDeclaredCliVersion. Reconciling the CLI must still leave the project
       Managed, which is the point of the state assertion below: the two pins disagreeing is a normal
       state, not a compatibility failure. */
    expect(manifest.scaffold.version).toBe('0.7.7');
    expect(manifest.scaffold.source.version).toBe('0.7.7');

    const state = await runCli(root, ['state']);
    expect(state.code).toBe(0);
    expect(state.json.data.project.compatibility.mode).toBe('managed');
  });

  it('never lets update treat a newer declared version as a downgrade to reconcile', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.xforge.version = '9.9.9';
      manifest.scaffold.version = '9.9.9';
      manifest.scaffold.source.version = '9.9.9';
    });
    const update = await runCli(root, ['update']);
    expect(update.code).toBe(1);
    expect(update.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CLI_IDENTITY_MISMATCH');
    const manifest = await yamlFile(root, 'xforge/manifest.yaml');
    expect(manifest.xforge.version).toBe('9.9.9');
  });

  it('never lets update reconcile across a Protocol mismatch even when the version is older', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.xforge.version = '0.7.7';
      manifest.scaffold.version = '0.7.7';
      manifest.scaffold.source.version = '0.7.7';
      manifest.xforge.protocol = '1';
    });
    const update = await runCli(root, ['update']);
    expect(update.code).toBe(1);
    expect(update.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_PROTOCOL_MISMATCH');
    const manifest = await yamlFile(root, 'xforge/manifest.yaml');
    expect(manifest.xforge.version).toBe('0.7.7');
  });
});

/*
 * `--field` exists because the alternative people reached for was wrong in a way nothing reported.
 *
 * `xforge state` carries a `contentRevision` inside every historical receipt as well as the current
 * one, so `grep -m1 contentRevision` returns whichever the serializer emitted first. A live XOps run
 * did exactly that and hand-wrote a verification receipt bound to a superseded revision.
 */
describe('state --field', () => {
  const CHANGE = 'add-feature';

  it('prints one value and nothing else, so a shell can capture it', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const full = await runCli(root, ['state', '--change', CHANGE]);
    expect(full.code).toBe(0);
    const expected = full.json.data.change.governance.revision.contentRevision;

    const field = await runCli(root, ['state', '--change', CHANGE, '--field', 'change.governance.revision.contentRevision']);
    expect(field.code).toBe(0);
    /* Exactly the value, with no envelope around it — that is what makes it capturable. */
    expect(field.stdout.trim()).toBe(expected);
    expect(field.stdout).not.toContain('Diagnostics');
    expect(field.stdout).not.toContain('protocolVersion');
  });

  /* `in` would answer `constructor` with `function Object() { [native code] }`: a confident value
     for a path the data does not contain, which is the failure this option exists to remove. */
  it('does not resolve inherited properties', async () => {
    const root = await fixture();
    for (const path of ['constructor', 'project.toString', 'project.hasOwnProperty']) {
      const result = await runCli(root, ['state', '--field', path]);
      expect(result.code, `--field ${path} should not resolve`).toBe(1);
      expect((result.json.diagnostics as any[]).map((item) => item.code)).toContain('XFORGE_FIELD_NOT_FOUND');
    }
  });

  it('fails loudly on a path that does not resolve, instead of printing nothing', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const missing = await runCli(root, ['state', '--change', CHANGE, '--field', 'change.governance.notAField']);
    /* An empty stdout with a zero exit is the failure this option exists to prevent: a shell would
       assign the empty string and carry on as though it held a revision. */
    expect(missing.code).toBe(1);
    const found = (missing.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_FIELD_NOT_FOUND');
    expect(found, JSON.stringify(missing.json.diagnostics)).toBeTruthy();
    /* And says what is actually there, so the next attempt is informed rather than another guess. */
    expect(found.message).toContain('currentStage');
  });
});

/*
 * Every `--field` path this product tells somebody to type, typed.
 *
 * The instruction shipped in 0.7.18 said `--field governance.revision.contentRevision`. That path
 * does not resolve — `state` nests it under `change.` — so an Agent following the Skill added to
 * stop it reading the revision by hand got exit 1 instead. Nothing caught it: the test suite used
 * the correct path, the Skill used a wrong one, and no test compared the two. A unit test cannot
 * read a Skill's prose, but it can take the strings out of it and run them, which is all this needs
 * to be. The same applies to the CLI's own help: an example nobody executes is a guess.
 */
describe('documented --field paths resolve', () => {
  /* Dotted paths only. `--field` is also followed by prose in the help description ("--field prints
     one value…"), and matching that made the test report the word "prints" as a broken path. */
  const FIELD = /--field ([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)/g;

  async function documentedPaths(): Promise<Array<{ source: string; path: string }>> {
    const found: Array<{ source: string; path: string }> = [];
    const roots = [
      path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'scaffold', 'skills'),
      path.join(repositoryRoot, 'scaffold', 'payload', 'xforge', 'scaffold', 'agents'),
    ];
    for (const root of roots) {
      for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const file = path.join(entry.parentPath ?? (entry as unknown as { path?: string }).path ?? root, entry.name);
        const text = await readFile(file, 'utf8');
        for (const match of text.matchAll(FIELD)) found.push({ source: path.relative(repositoryRoot, file), path: match[1]! });
      }
    }
    return found;
  }

  it('resolves every --field example shipped in a Skill, an Agent doc, or the CLI help', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    /* A Stage with real governance underneath it, so readyTransitions and revision are both live. */
    expect((await runCli(root, ['check', '--change', 'add-feature', '--gate', 'structure'])).code).toBe(0);

    const help = await runCli(root, ['help', 'state']);
    const fromHelp = [...String(help.json.data.commandHelp.description).matchAll(FIELD)]
      .map((match) => ({ source: 'cli.ts HELP.state', path: match[1]! }));
    const documented = [...await documentedPaths(), ...fromHelp];
    /* If this ever finds nothing, the regex has drifted from how the examples are written and the
       test is passing by looking at an empty list. */
    expect(documented.length).toBeGreaterThan(0);

    /* The check has teeth only if a wrong path fails, so the exact string that shipped in 0.7.18 is
       asserted to fail here. Without this, a resolver that accepted everything would pass silently
       and this whole test would be decoration. */
    const shipped = await runCli(root, ['state', '--change', 'add-feature', '--field', 'governance.revision.contentRevision']);
    expect(shipped.code, 'the prefix-less path must still fail, or this test proves nothing').toBe(1);

    const broken: string[] = [];
    for (const item of documented) {
      const result = await runCli(root, ['state', '--change', 'add-feature', '--field', item.path]);
      if (result.code !== 0) broken.push(`${item.source}: --field ${item.path}`);
    }
    expect(broken, `these documented --field paths do not resolve:\n${broken.join('\n')}`).toEqual([]);
  });
});

/*
 * Where an Artifact belongs is the CLI's answer to give, not the Agent's to infer.
 *
 * `generates` alone is relative to the Change directory and nothing said so, so an Agent running
 * from the project root wrote `assurance.md` there. `writePath` and the `writes` it feeds were
 * added for exactly that, and seventeen live-engine prompts went on repeating the rule in prose
 * afterwards. The prose is gone; this is what makes its removal safe, and what will fail if the
 * destination ever stops being stated.
 */
describe('a next action states where it writes', () => {
  it('never leaves writes empty for an Artifact the Change has still to produce', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await rm(path.join(root, 'xforge', 'changes', 'add-feature', 'design.md'));

    const state = await runCli(root, ['state', '--change', 'add-feature']);
    expect(state.code).toBe(0);
    const artifactActions = (state.json.nextActions as any[]).filter((item) => item.type === 'artifact');
    expect(artifactActions.length).toBeGreaterThan(0);
    for (const action of artifactActions) {
      expect(action.writes, `next action ${action.id} states no destination`).toBeTruthy();
      expect(action.writes.length).toBeGreaterThan(0);
      for (const destination of action.writes) {
        /* Project-relative, so it resolves from wherever the Agent runs the CLI. */
        expect(destination).toContain('xforge/changes/add-feature/');
      }
    }
  });
});
