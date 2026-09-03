import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { advanceSolidToApply, changeYaml, createCompleteSolidChange, fixture, runCli, updateYaml, write, yamlFile } from '../helpers.js';
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

  it('does not carry a command it no longer implements', async () => {
    /*
     * `brief` was deleted: a thirty-six-kilobyte document that had to be relayed verbatim through a
     * model's context to reach a person. A command table that still advertises it would send a
     * reader — or an Agent reading `xforge help` — after something that answers with
     * `XFORGE_COMMAND_UNKNOWN`, which reads as a broken install rather than a removed feature.
     */
    const root = await fixture();
    const help = await runCli(root, ['help']);
    expect(Object.keys(help.json.data.commands)).not.toContain('brief');

    const gone = await runCli(root, ['brief', '--change', 'add-feature']);
    expect(gone.code).toBe(1);
    expect(gone.json.diagnostics[0].code).toBe('XFORGE_COMMAND_UNKNOWN');
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
    expect(version.json.data).toMatchObject({ name: '@xforge/cli', version: '0.8.3', protocolVersion: '2' });

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
    expect(update.json.changes).toContainEqual(expect.objectContaining({ action: 'modify', path: 'xforge/manifest.yaml', source: 'xforge:declared-version-upgrade:0.7.7->0.8.3' }));
    const manifest = await yamlFile(root, 'xforge/manifest.yaml');
    expect(manifest.xforge.version).toBe('0.8.3');
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

  /* A mistyped field name used to answer with the whole resolved project: `--field nope.nope`
     returned `ok: false` and 47 KB of `data` the caller had explicitly narrowed away from. An
     Agent pays for that in context on every typo, and the diagnostic it carries already says the
     shape is not here -- "Run the command without --field ... to see the shape of data". */
  it('does not carry data when the field does not resolve', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const missing = await runCli(root, ['state', '--change', CHANGE, '--field', 'nope.nope']);
    expect(missing.code).toBe(1);
    expect(missing.json.data).toBeNull();
    /* The envelope is still a complete envelope -- only `data` is withheld. */
    expect(missing.json.ok).toBe(false);
    expect(missing.json.command).toBe('state');
    expect((missing.json.diagnostics as any[]).map((item) => item.code)).toContain('XFORGE_FIELD_NOT_FOUND');
  });

  /* One `--field` per value meant an Agent needing four governance values spent four processes and
     four round trips on them. Repeating the option answers them together. */
  it('answers several --field paths in one call, keyed by path', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, [
      'state', '--change', CHANGE,
      '--field', 'change.governance.currentStage',
      '--field', 'change.id',
    ]);
    expect(result.code).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(Object.keys(value).sort()).toEqual(['change.governance.currentStage', 'change.id']);
    expect(value['change.id']).toBe(CHANGE);
  });

  /* A single --field keeps printing the bare value, because `$(xforge state --field ...)` in a
     shell depends on it and wrapping it in JSON would break every existing caller. */
  it('still prints one bare value when only one --field is given', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, ['state', '--change', CHANGE, '--field', 'change.id']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(CHANGE);
  });

  /* And one bad path among several fails the whole call rather than answering partially: a caller
     that got three of four values would carry on believing it had all four. */
  it('fails the call when any one of several --field paths does not resolve', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, [
      'state', '--change', CHANGE,
      '--field', 'change.id',
      '--field', 'nope.nope',
    ]);
    expect(result.code).toBe(1);
    expect(result.json.data).toBeNull();
    const found = (result.json.diagnostics as any[]).find((item) => item.code === 'XFORGE_FIELD_NOT_FOUND');
    expect(found, JSON.stringify(result.json.diagnostics)).toBeTruthy();
    expect(found.message).toContain('nope.nope');
  });

  /* The Skills tell an Agent to consume the ready Action for the current revision -- which lives in
     `nextActions`, a sibling of `data` rather than a member of it. `--field` walked `data` only, so
     the one thing the Stage was told to read was the one thing it could not address, and 23 of 32
     `state` calls in a solid run took the whole envelope to get at it. */
  it('addresses envelope-level fields that are not inside data', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, ['state', '--change', CHANGE, '--field', 'nextActions']);
    expect(result.code).toBe(0);
    expect(Array.isArray(JSON.parse(result.stdout))).toBe(true);
  });

  /* `changes` names something in both, and `data` keeps it: an existing caller reading
     `--field changes` must not silently start receiving a different list. */
  it('resolves a name shared by data and the envelope against data, as before', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const viaField = await runCli(root, ['state', '--change', CHANGE, '--field', 'changes']);
    const full = await runCli(root, ['state', '--change', CHANGE]);
    expect(viaField.code).toBe(0);
    expect(JSON.parse(viaField.stdout)).toEqual((full.json.data as any).changes);
  });

  /* The exact call six Stage Skills now show. It exists as a test because the Skills are what an
     Agent copies: if this shape ever stops resolving, every Stage starts its work with an error.
     `--field context` was in it until `context` turned out to be a second copy of `change` and
     `specs`; the Skills dropped it in the same commit that removed the section. */
  it('answers the call the Stage Skills show, with every key a Stage was seen to use', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, [
      'state', '--change', CHANGE,
      '--field', 'nextActions',
      '--field', 'diagnostics',
      '--field', 'change',
    ]);
    expect(result.code).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(Object.keys(value).sort()).toEqual(['change', 'diagnostics', 'nextActions']);
    /* The ready Action a Stage is told to consume, and the governance subtree it resolves against. */
    expect(Array.isArray(value.nextActions)).toBe(true);
    expect(value.change.governance.currentStage).toBeTruthy();
  });

  /*
   * And it must send only what was asked for, which is the whole reason the Skills changed: a Stage
   * that fetched everything had its result offloaded and then spent further calls reading it back
   * in pieces.
   *
   * Asserted by naming the sections that must be absent rather than by a size ratio. The ratio used
   * to be `< 0.7` and it moved -- not because narrowing got worse, but because the full envelope it
   * is measured against lost the five `--include` sections and is now much closer to the narrow
   * form. A threshold that has to be relaxed every time the baseline improves is measuring the
   * baseline, not the behaviour.
   */
  it('sends only the fields that were asked for', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const narrow = await runCli(root, [
      'state', '--change', CHANGE,
      '--field', 'nextActions', '--field', 'diagnostics', '--field', 'change',
    ]);
    const full = await runCli(root, ['state', '--change', CHANGE]);
    expect(narrow.stdout.length).toBeLessThan(full.stdout.length);
    for (const absent of ['"flows"', '"targets"', '"installation"', '"activeChanges"', '"resources"']) {
      expect(narrow.stdout, `${absent} was not asked for`).not.toContain(absent);
    }
  });
});

/*
 * Five sections left `state` because none of them changes between two reads and all of them are
 * large: a measured solid run makes thirty-two `state` calls, so each was sent thirty-two times to
 * be read at most once. What matters is that they are *omitted*, not dropped — every one comes back
 * by name, and the payload says so where it would have been.
 */
describe('state --include', () => {
  const stateOf = async (root: string, extra: string[] = []) =>
    (await runCli(root, ['state', '--change', 'add-feature', ...extra])).json.data as any;

  it('leaves out the sections that do not change, and says how to get each back', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const data = await stateOf(root);

    expect(data.targets).toBeNull();
    expect(data.scaffold.lockedResources).toBeNull();
    expect(data.scaffold.lockedResourceCount).toBeGreaterThan(0);
    /* The Constitution's text is the copy that was redundant: `XFORGE.md` has it read at bootstrap
       and `stage-bundle` lists it at every Stage, so what stays here is where to find it. */
    expect(data.constitution.content).toBeUndefined();
    expect(data.constitution.path).toBeTruthy();
    expect(data.constitution.omitted).toContain('--include constitution');
  });

  it('returns only the Flow the Change runs, in full', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const data = await stateOf(root);
    expect(data.flows.map((flow: any) => flow.id)).toEqual(['solid']);
    /* In full, because `flowStages` in cli.ts stamps each Action's authority from these. */
    expect(data.flows[0].stages[0].authority).toBeTruthy();
  });

  it('lists every Flow as a catalogue when no Change is named, keeping the policy a choice needs', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const data = (await runCli(root, ['state'])).json.data as any;
    expect(data.flows.map((flow: any) => flow.id).sort()).toEqual(['major', 'quick', 'solid']);
    /* `xforge-propose` chooses a Flow against `eligibleWhen`/`requiredWhen`, so the catalogue keeps
       them; the stage list collapses to ids, which is all a listing was ever read for. */
    expect(data.flows[0].policy).toBeTruthy();
    expect(typeof data.flows[0].stages[0]).toBe('string');
  });

  it('gives each section back by name, and all of them at once', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);

    const withTargets = await stateOf(root, ['--include', 'targets']);
    expect(withTargets.targets).toBeTruthy();
    expect(withTargets.scaffold.lockedResources).toBeNull();

    const withAll = await stateOf(root, ['--include', 'all']);
    expect(withAll.targets).toBeTruthy();
    expect(withAll.scaffold.lockedResources).not.toBeNull();
    expect(withAll.constitution.content).toContain('#');
    expect(withAll.flows).toHaveLength(3);

    const repeated = await stateOf(root, ['--include', 'targets', '--include', 'constitution']);
    expect(repeated.targets).toBeTruthy();
    expect(repeated.constitution.content).toContain('#');
  });

  /* The one section that is cut by status rather than in whole: guidance for a document already
     written is the part of the payload with the shortest useful life. */
  it('drops the authoring guidance of a written Artifact and keeps it everywhere else', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const data = await stateOf(root);
    const artifacts = data.change.artifacts as any[];

    const done = artifacts.filter((artifact) => artifact.status === 'done');
    expect(done.length).toBeGreaterThan(0);
    for (const artifact of done) {
      expect(artifact.instruction, artifact.id).toBeUndefined();
      expect(artifact.outline, artifact.id).toBeUndefined();
      expect(artifact.guidance, artifact.id).toContain('--include artifacts');
      /* What identifies it stays: a listing still has to be readable. */
      expect(artifact.id).toBeTruthy();
      expect(artifact.writePath).toBeTruthy();
    }
    for (const artifact of artifacts.filter((item) => item.status !== 'done')) {
      expect(artifact.guidance, artifact.id).toBeUndefined();
    }

    const whole = await stateOf(root, ['--include', 'artifacts']);
    expect((whole.change.artifacts as any[]).every((artifact) => artifact.guidance === undefined)).toBe(true);
    expect((whole.change.artifacts as any[]).some((artifact) => artifact.outline)).toBe(true);
  });

  /* `nextArtifact` is the Artifact being written now, and `cli.ts:703` reads its outline to tell a
     `create-artifact` Action which sections to produce. It is a reference into the untrimmed list,
     so a Change with work still to do must carry the guidance for that work. */
  it('leaves the Artifact being written whole, and the Action that names its sections', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/add-feature/change.yaml', changeYaml('solid'));
    const result = await runCli(root, ['state', '--change', 'add-feature']);
    expect(result.code).toBe(0);
    const data = result.json.data as any;

    expect(data.change.nextArtifact.id).toBe('proposal');
    expect(data.change.nextArtifact.outline).toContain('## Why');
    expect(data.change.nextArtifact.instruction).toBeTruthy();
    /* And the Action built from it still states the headings. */
    const create = (result.json.nextActions as any[]).find((item) => item.action === 'create-artifact');
    expect(create.requiredSections).toContain('Why');
  });

  it('refuses a section it does not have, and names the ones it does', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, ['state', '--change', 'add-feature', '--include', 'nonsense']);
    expect(result.code).not.toBe(0);
    expect(JSON.stringify(result.json.diagnostics)).toContain('XFORGE_INCLUDE_UNKNOWN');
  });

  /* `--kind flows` walked the valid-kind check and answered `{}`, because `--kind` filters the
     resource listing and `SelectedResources` has no `flows`. A Skill instructed it. */
  it('sends --kind flows to the option that answers it', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, ['state', '--kind', 'flows']);
    expect(result.code).not.toBe(0);
    const said = JSON.stringify(result.json.diagnostics);
    expect(said).toContain('XFORGE_KIND_UNKNOWN');
    expect(said).toContain('--include flows');
  });
});

/*
 * How to finish a verification receipt was four paragraphs of Skill prose -- resident in every
 * verify Stage, read on every turn of it, and relevant at exactly one moment. It belongs where the
 * approval and transition instructions already live: a nextAction that appears when the receipt is
 * the thing standing between this Stage and the next, carrying the command already substituted.
 */
describe('verification receipt nextAction', () => {
  /* `successful` is private to helpers.ts; this asserts the same thing at the call site. */
  const ok = async (root: string, args: string[]) => {
    const result = await runCli(root, args);
    expect(result.code, `${args.join(' ')} failed: ${JSON.stringify(result.json?.diagnostics)}`).toBe(0);
    return result;
  };

  it('names the finalize command when the receipt is what blocks the Stage', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await advanceSolidToApply(root, 'add-feature');
    await ok(root, ['transition', '--change', 'add-feature', '--to', 'verify']);
    await ok(root, ['check', '--change', 'add-feature']);

    const state = await runCli(root, ['state', '--change', 'add-feature']);
    const actions = state.json.nextActions as any[];
    const finalize = actions.find((item) => item.action === 'finalize-verification');
    expect(finalize, `nextActions were: ${actions.map((item) => item.action).join(', ')}`).toBeTruthy();
    /* Substituted, not a template: an Agent that has to fill in <id> is being asked to transcribe. */
    expect(finalize.command).toEqual([
      'xforge', 'verification', 'finalize', '--change', 'add-feature',
      '--status', 'passed', '--by', '<the person asserting it>',
    ]);
    /* `passed` is substituted because it is the only status `finalize` accepts; `--by` is left a
       placeholder because it names a person, which is the assertion an Agent must not make. */
    expect(finalize.actor).toBe('human');
  });

  it('does not name it once the receipt is in place', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await advanceSolidToApply(root, 'add-feature');
    await ok(root, ['transition', '--change', 'add-feature', '--to', 'verify']);
    await ok(root, ['check', '--change', 'add-feature']);
    await ok(root, [
      'verification', 'finalize', '--change', 'add-feature', '--status', 'passed', '--by', 'tester',
    ]);
    const state = await runCli(root, ['state', '--change', 'add-feature']);
    const actions = state.json.nextActions as any[];
    expect(actions.find((item) => item.action === 'finalize-verification')).toBeFalsy();
  });
});

/*
 * Every `--field` path this product tells somebody to type, typed.
 *
 * The instruction shipped in 0.8.3 said `--field governance.revision.contentRevision`. That path
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

    /* The check has teeth only if a wrong path fails, so the exact string that shipped in 0.8.3 is
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

  /*
   * And which headings it must carry, verbatim.
   *
   * `outline` is a Markdown fragment in the Flow and reads as a suggested shape. A cold live run --
   * one given only a feature request, with nothing said about outlines -- wrote every required
   * section of its proposal and design, then on its check-report decorated two headings it wanted
   * to qualify: `## Completeness` became `## Completeness (at the current revision)`. The content
   * was right and the heading no longer resolved, which is what markers and the coverage rules
   * passages are keyed to.
   */
  it('states the headings the next Artifact must carry, verbatim', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await rm(path.join(root, 'xforge', 'changes', 'add-feature', 'design.md'));

    const state = await runCli(root, ['state', '--change', 'add-feature']);
    const design = (state.json.nextActions as any[]).find((item) => item.id === 'design');
    expect(design).toBeDefined();
    expect(design.requiredSections).toEqual([
      'Context', 'Goals and non-goals', 'Decisions and alternatives',
      'Failure modes and compatibility', 'Migration and rollback', 'Verification notes',
    ]);
  });

  /* A delta Spec's outline is a repeating template, so it has no literal section set to state. */
  it('states no headings for an Artifact whose outline is a repeating template', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await rm(path.join(root, 'xforge', 'changes', 'add-feature', 'specs', 'widget', 'spec.md'));

    const state = await runCli(root, ['state', '--change', 'add-feature']);
    const specs = (state.json.nextActions as any[]).find((item) => item.id === 'delta-specs');
    if (specs) expect(specs.requiredSections).toBeUndefined();
  });
});
