import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeYaml, clearVerification, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

async function addGate(root: string, id: string): Promise<void> {
  await write(root, `xforge/scaffold/gates/${id}.yaml`, [
    'apiVersion: xforge.dev/v1alpha1',
    'kind: Gate',
    'metadata:',
    `  name: ${id}`,
    '  version: 1',
    'spec:',
    '  stage: before-archive',
    '  required: true',
    "  command: [npm, test, '--if-present']",
    '  workingDirectory: .',
    '  timeoutSeconds: 900',
    '  maxOutputBytes: 65536',
    '  evidence: tests.json',
    '',
  ].join('\n'));
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.gates.push(id); });
}

async function addRule(root: string, id: string, spec: Record<string, unknown>): Promise<void> {
  await write(root, `xforge/scaffold/rules/${id}.yaml`, JSON.stringify({
    apiVersion: 'xforge.dev/v1alpha2', kind: 'Rule', metadata: { name: id }, spec,
  }));
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.rules.push(id); });
}

async function addSkill(root: string, id: string): Promise<void> {
  await write(root, `xforge/scaffold/skills/${id}/SKILL.md`, `---\nname: ${id}\ndescription: test-only orphan Skill\n---\n\nUnused by design.\n`);
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.skills.push(id); });
}

async function addMcpServer(root: string, id: string): Promise<void> {
  await write(root, `xforge/scaffold/mcp-servers/${id}.yaml`, [
    'apiVersion: xforge.dev/v1alpha2', 'kind: McpServer', 'metadata:', `  name: ${id}`, '  version: 1',
    'spec:', '  transport: stdio', '  command: [node, server.mjs]', '  authTokenEnv: XFORGE_TEST_TOKEN', '  timeoutSeconds: 10', '',
  ].join('\n'));
  await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
    manifest.scaffold.mcpServers = [...(manifest.scaffold.mcpServers ?? []), id];
  });
}

/*
 * Flows are the one governed asset `upgrade-scaffold` structurally cannot reach: they live in
 * `xforge/flows/`, and the upgrade walks only `xforge/scaffold/`. A project therefore keeps whatever
 * Flow it was initialised with, for as long as it exists, and until now nothing said so. One ran an
 * entire Major three releases behind its own CLI -- two approvers where the shipped Flow asks for
 * one non-implementer, and a Check Stage missing from `verify.reworkTo` -- and found out by reading
 * the npm payload by hand.
 *
 * Reported as `info`, not a warning: customising a Flow is supported, and a finding a project can
 * never clear is how a report gets skimmed.
 */
describe('doctor and Flow version drift', () => {
  it('says when a policy exemption cannot fire on any target this project installs', async () => {
    /*
     * `exceptActors` is expressible in no shipped target's own permission layer, so the exemption
     * lives only in the runtime Hook bridge — which needs the host to identify the calling
     * sub-agent. A live run configured one, watched the exempted actor be denied along with
     * everyone else, and had nothing telling it that the policy had become an unconditional deny.
     */
    const root = await fixture();
    const result = await runCli(root, ['doctor']);
    const finding = result.json.data.suggestions.find((item: any) => item.code === 'XFORGE_DOCTOR_POLICY_EXEMPTION_UNENFORCEABLE');
    expect(finding.id).toBe('protected-files');
    expect(finding.severity).toBe('info');
    expect(finding.message).toContain('unconditional deny');
    /* Reported by doctor rather than by install: the condition holds for every project today, so a
       per-install warning would fire on every run. */
    const installed = await runCli(root, ['install']);
    expect(installed.json.diagnostics.some((item: any) => item.code.includes('EXEMPTION'))).toBe(false);
  });

  it('reports a Flow whose version differs from the one this CLI ships', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => { flow.metadata.version = 1; });

    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    const drift = (result.json.data.suggestions as any[]).filter((item) => item.code === 'XFORGE_DOCTOR_FLOW_VERSION_DRIFT');
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ scope: 'flows', id: 'solid', severity: 'info', path: 'xforge/flows/solid.yaml' });
    expect(drift[0].message).toContain('version 1');
    /* The remedy has to name both options, because adopting is not always the right one. */
    expect(drift[0].message).toContain('deliberate');
  });

  /*
   * The kind of staleness a version comparison cannot see.
   *
   * The RUNBOOK records the same trap for the globally installed CLI: during development the work
   * tree and the global install carry the same version number while their contents differ, so
   * comparing numbers reports agreement that is not there. A Flow is the one governed asset no
   * upgrade path touches, which makes it the easiest place for the same thing to happen quietly.
   */
  it('reports a Flow whose version matches the shipped one but whose content does not', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
      /* Version untouched on purpose; only the content moves. */
      flow.artifacts.find((artifact: any) => artifact.id === 'proposal').description = 'Edited in place';
    });

    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    const findings = (result.json.data.suggestions as any[]).filter((item) => item.code === 'XFORGE_DOCTOR_FLOW_CONTENT_DRIFT');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ scope: 'flows', id: 'solid', severity: 'info', path: 'xforge/flows/solid.yaml' });
    /* And it must not also be reported as a version drift, which would be two findings for one fact. */
    expect((result.json.data.suggestions as any[]).filter((item) => item.code === 'XFORGE_DOCTOR_FLOW_VERSION_DRIFT')).toEqual([]);
  });

  it('says nothing when the project Flow matches the shipped one', async () => {
    const root = await fixture();
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect((result.json.data.suggestions as any[]).filter((item) => item.code === 'XFORGE_DOCTOR_FLOW_VERSION_DRIFT')).toEqual([]);
  });
});

describe('doctor', () => {
  it('reports only unused Flows on an unmodified fixture, because every shipped asset is now cited', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.data.danglingReferences).toEqual([]);
    expect(result.json.data.deadCode).toEqual([]);
    /* The shipped Rules cite protected-files, so the freestanding-policy finding is gone. The old
       expectation encoded an empty Rule layer: a policy nobody referenced was the normal state. */
    expect(result.json.data.uncited.map((item: any) => item.id)).not.toContain('protected-files');
    expect(result.json.data.unusedFlows.map((item: any) => item.id).sort()).toEqual(['major', 'quick']);
  });

  /**
   * The most ordinary team event there is, and the one `doctor` did not notice.
   *
   * `xforge/.state.json` is rewritten in full by every install, so two branches that both installed
   * conflict in it. Conflicted, it is no longer JSON: `state`, `install`, `sync` and `update` all
   * refused at the first read with `Next actions: []`, while `check` passed and `doctor` reported
   * unused Flows. Both halves are asserted -- the tool that says what is wrong must say it, and the
   * commands that refuse must say how to recover.
   */
  /**
   * `dependsOn` is the declaration `module-boundaries` reads, and it did not exist until now: the
   * Gate's own header named it from the day it shipped while the Manifest schema was
   * additionalProperties: false over {id, path, kind}, so a project following that line was
   * rejected by the schema. Adding the field without checking the ids in it would have shipped one
   * more declaration nobody compares against anything.
   */
  it('refuses a module dependency that names a module this project does not declare', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest: any) => {
      manifest.project.modules = [
        { id: 'api', path: 'src/api', kind: 'service', dependsOn: ['store'] },
        { id: 'store', path: 'src/store', kind: 'library', dependsOn: ['nowhere'] },
      ];
      return manifest;
    });
    const result = await runCli(root, ['check', '--change', 'add-feature']);
    expect(result.json.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'XFORGE_MODULE_DEPENDS_ON_UNKNOWN', severity: 'error' }),
    ]));
    /* And the legal direction beside it must not be reported, or the check is just noise. */
    const messages = (result.json.diagnostics as any[]).filter((item) => item.code === 'XFORGE_MODULE_DEPENDS_ON_UNKNOWN').map((item) => item.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('nowhere');
  });

  it('refuses a module that lists itself, which reads as a declaration and is not one', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest: any) => {
      manifest.project.modules = [{ id: 'api', path: 'src/api', kind: 'service', dependsOn: ['api'] }];
      return manifest;
    });
    const result = await runCli(root, ['check', '--change', 'add-feature']);
    expect(result.json.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'XFORGE_MODULE_DEPENDS_ON_SELF', severity: 'error' }),
    ]));
  });

  it('reports an unreadable ownership state, and offers the rebuild that fixes it', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    expect((await runCli(root, ['install'])).code).toBe(0);
    const statePath = path.join(root, 'xforge', '.state.json');
    const original = await readFile(statePath, 'utf8');
    await writeFile(statePath, `<<<<<<< HEAD\n${original}=======\n${original}>>>>>>> other\n`);

    const doctored = await runCli(root, ['doctor']);
    expect(doctored.code).toBe(1);
    expect(doctored.json.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'XFORGE_DOCTOR_OWNERSHIP_UNREADABLE', severity: 'error' }),
    ]));

    const state = await runCli(root, ['state']);
    expect(state.code).toBe(1);
    expect(state.json.nextActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'rebuild-ownership-state', command: ['xforge', 'install'] }),
    ]));

    /* And the offered repair has to work, or it is one more thing that is merely said. */
    await rm(statePath);
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['state'])).code).toBe(0);
  });

  it('reports the Hook bypasses XForge cannot observe whenever a project has PermissionPolicies', async () => {
    /* A standing suggestion, not a warning, and gated on the project actually having policies: a
       project with none is not relying on Hooks for anything, so the blind spot is not its problem. */
    const root = await fixture();
    await createCompleteSolidChange(root);
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    const finding = result.json.data.suggestions.find((item: any) => item.code === 'XFORGE_DOCTOR_HOOK_SUPPRESSION_UNVERIFIABLE');
    expect(finding).toBeDefined();
    /* It must name the mechanisms rather than gesturing at them -- the point of the finding is that
       the reader can go check the two the CLI cannot see. */
    expect(finding.message).toContain('disableAllHooks');
    expect(finding.message).toContain('allowManagedHooksOnly');
    /* And it must not imply coverage it does not have. */
    expect(finding.message).toContain('cannot observe');
  });

  it('reports a locally disabled Hook layer, which is the one suppression inside the project root', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, '.claude/settings.json', JSON.stringify({ disableAllHooks: true }, null, 2));
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'policies', code: 'XFORGE_DOCTOR_HOOKS_DISABLED_LOCALLY', path: '.claude/settings.json' }),
    ]));
  });

  it('does not report a locally disabled Hook layer when the key is absent or false', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, '.claude/settings.json', JSON.stringify({ disableAllHooks: false }, null, 2));
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.suggestions.map((item: any) => item.code)).not.toContain('XFORGE_DOCTOR_HOOKS_DISABLED_LOCALLY');
  });

  it('flags an enabled Gate that no Flow Stage or archive terminal references as dead code', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await addGate(root, 'orphan-gate');
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.deadCode).toEqual([
      expect.objectContaining({ scope: 'gates', code: 'XFORGE_DOCTOR_DEAD_CODE', id: 'orphan-gate' }),
    ]);
    expect(result.json.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'XFORGE_DOCTOR_DEAD_CODE', severity: 'warning' }),
    ]));
  });

  it('flags a Rule approvalRef pointing at an Approval policy no Flow declares, and clears a policyRef from uncited', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await addRule(root, 'reference-check', {
      severity: 'should', instruction: 'Test-only Rule exercising doctor reverse-reference checks.',
      scope: {}, enforcement: { gateRefs: [], policyRefs: ['protected-files'], approvalRefs: ['does-not-exist'] },
    });
    // install refuses an unresolved Rule.approvalRefs entry (a real structural error); doctor is
    // read-only and reports it as a warning finding without requiring a fresh Lock first.
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.danglingReferences).toEqual([
      expect.objectContaining({ scope: 'approvals', code: 'XFORGE_RULE_APPROVAL_UNKNOWN' }),
    ]);
    expect(result.json.data.uncited.map((item: any) => item.id)).not.toContain('protected-files');
  });

  it('flags an enabled Skill no Flow Stage references as uncited, unless it is a known standalone built-in', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await addSkill(root, 'orphan-skill');
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.uncited).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'skills', code: 'XFORGE_DOCTOR_UNCITED', id: 'orphan-skill' }),
    ]));
    expect(result.json.data.uncited.map((item: any) => item.id)).not.toContain('xforge-kanban');
  });

  it('--kind filters the report to a single resource scope', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await addGate(root, 'orphan-gate');
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['doctor', '--kind', 'gates']);
    expect(result.code).toBe(0);
    expect(result.json.data.kind).toBe('gates');
    expect(result.json.data.deadCode.map((item: any) => item.id)).toEqual(['orphan-gate']);
    expect(result.json.data.uncited).toEqual([]);
    expect(result.json.data.unusedFlows).toEqual([]);
  });

  it('--strict turns findings into a failing exit code without changing them without the flag', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    const relaxed = await runCli(root, ['doctor']);
    expect(relaxed.code).toBe(0);
    expect(relaxed.json.ok).toBe(true);
    const strict = await runCli(root, ['doctor', '--strict']);
    expect(strict.code).toBe(1);
    expect(strict.json.ok).toBe(false);
    expect(strict.json.data).toEqual(relaxed.json.data);
  });

  it('flags a Flow-declared Approval policy that no Stage exit or the archive terminal references as dead code', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
      flow.governance.approvalPolicies.push({ id: 'orphan-approval', minApprovers: 1, roles: ['owner'], separationOfDuties: false, providers: ['enterprise-hmac'] });
    });
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.deadCode).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'approvals', code: 'XFORGE_DOCTOR_DEAD_CODE', id: 'orphan-approval' }),
    ]));
  });

  it('counts a legacy v1alpha1 Flow archive mandatoryGates entry as a reference, so that Gate is not reported dead', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, 'xforge/scaffold/gates/legacy-only-gate.yaml', [
      'apiVersion: xforge.dev/v1alpha1', 'kind: Gate', 'metadata:', '  name: legacy-only-gate', '  version: 1',
      'spec:', '  stage: before-archive', '  required: true', "  command: [npm, test, '--if-present']",
      '  workingDirectory: .', '  timeoutSeconds: 900', '  maxOutputBytes: 65536', '  evidence: tests.json', '',
    ].join('\n'));
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.gates.push('legacy-only-gate'); });
    await write(root, 'xforge/flows/legacy-smoke.yaml', [
      'apiVersion: xforge.dev/v1alpha1', 'kind: Flow', 'metadata:', '  name: legacy-smoke', '  version: 1',
      '  description: Test-only legacy Flow exercising doctor Gate reference collection.',
      'artifacts:', '  - id: note', '    generates: note.md', '    description: Placeholder artifact',
      '    instruction: Write a short note.', "    outline: '# Note'", '    requires: []',
      'operations:', '  apply:', '    requires: [note]', '    tracks: note.md',
      '  archive:', '    requires: [note]', '    syncSpecs: false', '    mandatoryGates: [legacy-only-gate]', '',
    ].join('\n'));
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.deadCode.map((item: any) => item.id)).not.toContain('legacy-only-gate');
  });

  it('does not crash when the Changes directory does not exist', async () => {
    const root = await fixture();
    await rm(path.join(root, 'xforge', 'changes'), { recursive: true, force: true });
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.ok).toBe(true);
    /* And says nothing about unused Flows, because with no Change in existence there is nothing
       for a Flow to be unused *by*. See the suppression test below for why that matters. */
    expect(result.json.data.unusedFlows).toEqual([]);
  });

  /*
   * Three Flows ship and one is the Manifest default, so before this a freshly initialised project
   * always got exactly two unused-Flow findings — including, in the run that reported it, the very
   * Flow the operator was about to use. Nothing could be done about them, and a finding that is
   * always present and never actionable is the thing that teaches people to skim past findings that
   * are. `doctor` already declines to report XFORGE_POLICY_STATIC_LAYER_DEGRADED for this reason.
   */
  it('says nothing about unused Flows until a Change exists to leave one unused', async () => {
    const root = await fixture();
    const fresh = await runCli(root, ['doctor']);
    expect(fresh.code).toBe(0);
    expect(fresh.json.data.unusedFlows).toEqual([]);
    expect(fresh.json.data.summary.unusedFlows).toBe(0);

    /* Once a Change picks one, the other two are genuinely unchosen and the finding is earned. */
    await write(root, 'xforge/changes/pick-solid/change.yaml', changeYaml('solid'));
    const chosen = await runCli(root, ['doctor']);
    expect(chosen.json.data.unusedFlows.map((item: any) => item.id).sort()).toEqual(['major', 'quick']);
  });

  it('skips an active Change whose change.yaml is malformed YAML instead of crashing', async () => {
    const root = await fixture();
    await write(root, 'xforge/changes/good-change/change.yaml', changeYaml('quick'));
    await write(root, 'xforge/changes/broken-change/change.yaml', 'flow: quick\nflow: solid\n');
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.ok).toBe(true);
    expect(result.json.data.unusedFlows.map((item: any) => item.id)).toEqual(['major']);
  });

  /*
   * Both of these are questions a project can answer on day one, and both used to surface only when
   * a Change ran into them: the undeclared Gate as a blocked maintenance action partway through the
   * first Change, the approval shape as XFORGE_APPROVAL_INTERACTIVE_REQUIRED at the first approval.
   * They are `info` suggestions, not findings — an unanswered question is not a misconfiguration,
   * and in both cases the mechanism that actually enforces the answer is still in place.
   */
  it('suggests declaring a command for a required declared Gate before a Change needs it', async () => {
    const root = await fixture();
    /* The fixture answers this question already, which is the normal state for a working project.
       A project that has never answered it is the one this suggestion exists for. */
    await clearVerification(root);
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    const undeclaredIds = (result.json.data.suggestions as any[])
      .filter((item) => item.code === 'XFORGE_DOCTOR_VERIFICATION_UNDECLARED').map((item) => item.id).sort();
    /* Both required `declared` Gates the Scaffold enables, each named separately: they are two
       different questions and answering one says nothing about the other. */
    expect(undeclaredIds, JSON.stringify(result.json.data.suggestions)).toEqual(['security-scan', 'unit-tests']);
    const undeclared = (result.json.data.suggestions as any[]).find((item) => item.id === 'unit-tests');
    expect(undeclared.severity).toBe('info');
    /* It must carry the command that answers it, and the warning against answering it carelessly:
       a test command on a repository with no tests passes the Gate while asserting nothing. */
    expect(undeclared.message).toContain('xforge verification declare');
    expect(undeclared.message).toContain('asserting nothing');

    /* Answering it closes the suggestion. */
    const declared = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests', '--command', '["npm","test"]', '--by', 'Dana Reed']);
    expect(declared.code, JSON.stringify(declared.json?.diagnostics ?? declared)).toBe(0);
    const answered = await runCli(root, ['doctor']);
    /* Only the Gate that was answered goes quiet. */
    expect((answered.json.data.suggestions as any[])
      .filter((item) => item.code === 'XFORGE_DOCTOR_VERIFICATION_UNDECLARED').map((item) => item.id)).toEqual(['security-scan']);
  });

  /* A dismissal says "this Gate deliberately does not cover that toolchain". It is not a command,
     so a Gate holding only dismissals still has nothing to run and `runners/gate.ts` still refuses
     it. doctor has to agree, or it goes quiet about a Gate that is going to block anyway. */
  it('keeps asking when a declared Gate has only a dismissal and no command', async () => {
    const root = await fixture();
    await clearVerification(root);
    const dismissed = await runCli(root, ['verification', 'declare', '--gate-name', 'unit-tests',
      '--not-applicable', 'package.json', '--justification', 'No JavaScript in this repository.', '--by', 'Dana Reed']);
    expect(dismissed.code, JSON.stringify(dismissed.json?.diagnostics)).toBe(0);

    const result = await runCli(root, ['doctor']);
    expect((result.json.data.suggestions as any[])
      .filter((item) => item.code === 'XFORGE_DOCTOR_VERIFICATION_UNDECLARED').map((item) => item.id))
      .toContain('unit-tests');
  });

  it('reports that approvals can only be collected at a terminal, without calling local unusable', async () => {
    const root = await fixture();
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    const interactive = (result.json.data.suggestions as any[]).find((item) => item.code === 'XFORGE_DOCTOR_APPROVALS_INTERACTIVE_ONLY');
    expect(interactive, JSON.stringify(result.json.data.suggestions)).toBeTruthy();
    expect(interactive.severity).toBe('info');

    /* The existing policy-unusable finding must stay silent: `local` is a working provider, and a
       person opening a terminal to type a decision is the design, not a defect. Reclassifying it
       would report every default project as having no way to approve anything. */
    expect((result.json.data.unusableApprovals as any[]).map((item) => item.id)).toEqual([]);
  });

  /*
   * "Only at a terminal" is a claim about `local`, and a policy that does not declare `local` has
   * no terminal to be reachable at. `reachable` never checked for it, so a policy backed by one
   * unconfigured mcp provider drew both findings at once: the unusable one, which is true, and this
   * one, which told the reader to open a real terminal for an approval `xforge approve` refuses
   * outright with XFORGE_APPROVAL_PROVIDER_FORBIDDEN.
   */
  it('does not call a policy interactive-only when no terminal can satisfy it either', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
      flow.governance.approvalPolicies.find((policy: any) => policy.id === 'planning-solid').providers = ['enterprise-approvals'];
    });
    const result = await runCli(root, ['doctor']);
    expect((result.json.data.unusableApprovals as any[]).map((item) => item.id)).toContain('planning-solid');
    const interactive = (result.json.data.suggestions as any[]).find((item) => item.code === 'XFORGE_DOCTOR_APPROVALS_INTERACTIVE_ONLY');
    /* `closing-solid` still declares local and is still interactive-only, so the finding survives —
       what must not survive is the policy that has no local provider at all. */
    expect(interactive.message).toContain('solid/closing-solid');
    expect(interactive.message).not.toContain('solid/planning-solid');
  });

  it('flags a Flow Stage gates entry pointing at a non-enabled Gate', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow) => {
      const verify = flow.stages.find((stage: any) => stage.id === 'verify');
      verify.gates.push('ghost-gate');
    });
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.danglingReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'gates', code: 'XFORGE_FLOW_GATE_DISABLED' }),
    ]));
  });

  it('flags a Hook scriptRef pointing at a non-existent Script, and never reverse-checks Hooks for dead code or uncited', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await write(root, 'xforge/scaffold/hooks/ghost-script-hook.yaml', [
      'apiVersion: xforge.dev/v1alpha2', 'kind: Hook', 'metadata:', '  name: ghost-script-hook',
      'spec:', '  enabled: false', '  plane: runtime', '  event: agent.tool.after',
      '  action:', '    scriptRef: ghost-script', '  failurePolicy: warn', '  timeoutSeconds: 10', '',
    ].join('\n'));
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.hooks.push('ghost-script-hook'); });
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.danglingReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'hooks', code: 'XFORGE_HOOK_SCRIPT_MISSING' }),
    ]));
    expect(result.json.data.uncited.some((item: any) => item.scope === 'hooks')).toBe(false);
    expect(result.json.data.deadCode.some((item: any) => item.scope === 'hooks')).toBe(false);
  });

  it('flags an mcp Approval provider pointing at a non-registered McpServer', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.approvals.providers.push({ id: 'ghost-provider', type: 'mcp', mcpServer: 'ghost-server', roles: ['owner'] });
    });
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.danglingReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'mcp-servers', code: 'XFORGE_APPROVAL_MCP_SERVER_UNKNOWN' }),
    ]));
  });

  it('flags a registered McpServer no approvals provider references as uncited', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await addMcpServer(root, 'orphan-mcp-server');
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.uncited).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'mcp-servers', code: 'XFORGE_DOCTOR_UNCITED', id: 'orphan-mcp-server' }),
    ]));
  });

  it('clears a registered McpServer from uncited once an mcp Approval provider references it', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await addMcpServer(root, 'review-bot');
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.approvals.providers.push({ id: 'review-bot', type: 'mcp', mcpServer: 'review-bot', roles: ['owner'] });
    });
    expect((await runCli(root, ['install'])).code).toBe(0);
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.uncited.map((item: any) => item.id)).not.toContain('review-bot');
    expect(result.json.data.danglingReferences.some((item: any) => item.code === 'XFORGE_APPROVAL_MCP_SERVER_UNKNOWN')).toBe(false);
  });

  it('flags an Agent delegation.callableBy entry pointing at an unknown caller', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/agents/worker.yaml', (agent) => {
      agent.spec.delegation.callableBy.push('ghost-caller');
    });
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.danglingReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'agents', code: 'XFORGE_AGENT_CALLER_UNKNOWN' }),
    ]));
  });
});
