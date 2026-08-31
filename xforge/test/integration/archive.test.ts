import { access, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { advanceSolidToReadyToArchive, approvalTestEnv, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function tree(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    result.push(`${entry.isDirectory() ? 'd' : 'f'}:${relative}`);
    if (entry.isDirectory()) result.push(...await tree(path.join(directory, entry.name), relative));
  }
  return result;
}

describe('archive transaction', () => {
  it('keeps dry-run at zero writes, then gates, syncs, and moves atomically', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => { gate.spec.command = [process.execPath, '-e', 'process.exit(0)']; delete gate.spec.builtin; });
    expect((await runCli(root, ['install'])).code).toBe(0);
    await advanceSolidToReadyToArchive(root);
    const before = await tree(root);
    const dry = await runCli(root, ['archive', '--change', 'add-feature', '--dry-run'], approvalTestEnv);
    expect(dry.code).toBe(0);
    expect(dry.json.data.mandatoryGates).toEqual(['structure', 'unit-tests']);
    expect(dry.json.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'create', path: 'xforge/specs/widget/spec.md' }),
      expect.objectContaining({ action: 'move', from: 'xforge/changes/add-feature' }),
    ]));
    expect(await tree(root)).toEqual(before);

    const archived = await runCli(root, ['archive', '--change', 'add-feature'], approvalTestEnv);
    expect(archived.code, JSON.stringify(archived.json.diagnostics, null, 2)).toBe(0);
    expect(await exists(path.join(root, 'xforge', 'changes', 'add-feature'))).toBe(false);
    const archiveRoot = path.join(root, 'xforge', 'changes', 'archive');
    const archiveNames = await readdir(archiveRoot);
    expect(archiveNames).toHaveLength(1);
    expect(archiveNames[0]).toMatch(/^\d{4}-\d{2}-\d{2}-add-feature$/);
    expect(await readFile(path.join(root, 'xforge', 'specs', 'widget', 'spec.md'), 'utf8')).toContain('### Requirement: Widget works');
    expect(await exists(path.join(archiveRoot, archiveNames[0]!, 'evidence', 'tests.json'))).toBe(true);
  });

  it('merges a contract delta into the baseline in the same transaction as the Spec merge', async () => {
    /*
     * The whole point of the contract baseline, end to end. A Change declares an interface delta, and
     * the record of what the modules promise each other advances only when that Change archives --
     * so the next Change starts from what was agreed rather than from what the last one happened to
     * leave in the working tree.
     *
     * Both merges go through one transaction on purpose. A separate contract transaction would let a
     * Spec merge succeed beside a contract merge that failed, which is a repository stating two
     * different things about the same Change.
     */
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => { gate.spec.command = [process.execPath, '-e', 'process.exit(0)']; delete gate.spec.builtin; });
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow: any) => {
      flow.artifacts.push({
        id: 'contract-delta',
        generates: 'contracts/**/*.md',
        validator: 'contract-delta',
        description: 'Declare this Change\'s delta to the module interface baseline',
        instruction: 'List every contract element this Change adds, modifies or removes.',
        outline: '## ADDED Contract Elements\n## MODIFIED Contract Elements\n## REMOVED Contract Elements\n',
      });
      flow.stages.find((stage: any) => stage.id === 'design').produces.push('contract-delta');
      flow.terminal.archive.syncContracts = true;
    });
    await write(root, 'xforge/contracts/http.md', [
      '# http', '', '## Purpose', '', 'Established by archived XForge Changes.', '', '## Elements', '',
      '### Element: openapi:paths./orders.get', '', '- module: api', '',
    ].join('\n'));
    await write(root, 'xforge/changes/add-feature/contracts/http.md', [
      '## ADDED Contract Elements', '',
      '### Element: openapi:paths./orders.post', '', '- module: api', '',
      '## MODIFIED Contract Elements', '', '(none)', '',
      '## REMOVED Contract Elements', '', '(none)', '',
    ].join('\n'));
    expect((await runCli(root, ['install'])).code).toBe(0);
    await advanceSolidToReadyToArchive(root);

    const dry = await runCli(root, ['archive', '--change', 'add-feature', '--dry-run'], approvalTestEnv);
    expect(dry.code, JSON.stringify(dry.json.diagnostics, null, 2)).toBe(0);
    /* Reported apart from `specs`, because a reader that has always been able to treat every entry
       there as a canonical Spec would otherwise silently start being wrong about some of them. */
    expect(dry.json.data.specs).toEqual(['xforge/specs/widget/spec.md']);
    expect(dry.json.data.contracts).toEqual(['xforge/contracts/http.md']);

    const archived = await runCli(root, ['archive', '--change', 'add-feature'], approvalTestEnv);
    expect(archived.code, JSON.stringify(archived.json.diagnostics, null, 2)).toBe(0);
    const baseline = await readFile(path.join(root, 'xforge', 'contracts', 'http.md'), 'utf8');
    expect(baseline).toContain('### Element: openapi:paths./orders.get');
    expect(baseline).toContain('### Element: openapi:paths./orders.post');
  });

  it('refuses at check, before an approval is given, when the contract delta cannot merge', async () => {
    /*
     * The failure this check exists to move earlier. `planArchive` plans no mutation while any
     * governance block stands, and "the closing approval is missing" is one -- so an unmergeable
     * delta could not be discovered until after the approval had been collected, and the only route
     * back voids it. Two files, no Gate, no approval, no working tree.
     */
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/flows/solid.yaml', (flow: any) => {
      flow.artifacts.push({
        id: 'contract-delta',
        generates: 'contracts/**/*.md',
        validator: 'contract-delta',
        description: 'Declare this Change\'s delta to the module interface baseline',
        instruction: 'List every contract element this Change adds, modifies or removes.',
        outline: '## ADDED Contract Elements\n## MODIFIED Contract Elements\n## REMOVED Contract Elements\n',
      });
      flow.stages.find((stage: any) => stage.id === 'design').produces.push('contract-delta');
      flow.terminal.archive.syncContracts = true;
    });
    await write(root, 'xforge/contracts/http.md', '# http\n\n## Elements\n\n### Element: openapi:paths./orders.get\n\n- module: api\n');
    await write(root, 'xforge/changes/add-feature/contracts/http.md', [
      '## ADDED Contract Elements', '', '### Element: openapi:paths./orders.get', '', '- module: api', '',
    ].join('\n'));
    expect((await runCli(root, ['install'])).code).toBe(0);

    const checked = await runCli(root, ['check', '--change', 'add-feature']);
    const codes = checked.json.diagnostics.map((item: any) => item.code);
    expect(codes).toContain('XFORGE_CONTRACT_MERGE_CONFLICT');
    const conflict = checked.json.diagnostics.find((item: any) => item.code === 'XFORGE_CONTRACT_MERGE_CONFLICT');
    expect(conflict.message).toContain('openapi:paths./orders.get');
    expect(conflict.path).toBe('xforge/changes/add-feature/contracts/http.md');
  });

  it('blocks archive on a missing Artifact or failed mandatory Gate', async () => {
    const incompleteRoot = await fixture();
    await createCompleteSolidChange(incompleteRoot);
    /* The verification receipt is no longer an Artifact — it is a Stage exit condition decided
       against real Gate Evidence — so the artifact-completeness block is pinned on `assurance`,
       which still is one. */
    await rm(path.join(incompleteRoot, 'xforge', 'changes', 'add-feature', 'assurance.md'));
    const incomplete = await runCli(incompleteRoot, ['archive', '--change', 'add-feature', '--dry-run']);
    expect(incomplete.code).toBe(1);
    expect(incomplete.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_ARCHIVE_ARTIFACTS_INCOMPLETE');

    const failedRoot = await fixture();
    await createCompleteSolidChange(failedRoot);
    await updateYaml(failedRoot, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => { gate.spec.command = [process.execPath, '-e', "const fs=require('node:fs'); process.exit(fs.existsSync('fail-gate') ? 2 : 0)"]; delete gate.spec.builtin; });
    expect((await runCli(failedRoot, ['install'])).code).toBe(0);
    await advanceSolidToReadyToArchive(failedRoot);
    await write(failedRoot, 'fail-gate', 'fail\n');
    const failed = await runCli(failedRoot, ['archive', '--change', 'add-feature'], approvalTestEnv);
    expect(failed.code).toBe(1);
    expect(failed.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_GATE_FAILED');
    expect(await exists(path.join(failedRoot, 'xforge', 'changes', 'add-feature'))).toBe(true);
    expect(await exists(path.join(failedRoot, 'xforge', 'specs', 'widget', 'spec.md'))).toBe(false);
  });

  /*
   * P0-7: `xforge/.audit/**` is gitignored, so a fresh clone or a CI runner never has the local
   * chain. Archive must decide from the committed `<change>/evidence/audit/index.json`.
   */
  it('archives on a machine that has no local audit chain at all', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => { gate.spec.command = [process.execPath, '-e', 'process.exit(0)']; delete gate.spec.builtin; });
    expect((await runCli(root, ['install'])).code).toBe(0);
    await advanceSolidToReadyToArchive(root);
    const index = JSON.parse(await readFile(path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'audit', 'index.json'), 'utf8'));
    expect(Object.keys(index.eventTypes)).toEqual(expect.arrayContaining(['gate.after', 'stage.entered', 'approval.decided']));

    await rm(path.join(root, 'xforge', '.audit'), { recursive: true, force: true });
    const archived = await runCli(root, ['archive', '--change', 'add-feature'], approvalTestEnv);
    expect(archived.code, JSON.stringify(archived.json.diagnostics, null, 2)).toBe(0);
    expect(await exists(path.join(root, 'xforge', 'changes', 'add-feature'))).toBe(false);
  });

  it('blocks archive when the committed audit index was hand-edited', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => { gate.spec.command = [process.execPath, '-e', 'process.exit(0)']; delete gate.spec.builtin; });
    expect((await runCli(root, ['install'])).code).toBe(0);
    await advanceSolidToReadyToArchive(root);
    const indexPath = path.join(root, 'xforge', 'changes', 'add-feature', 'evidence', 'audit', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.eventTypes['gate.after'] = { count: 99, lastTimestamp: new Date().toISOString(), lastHash: 'f'.repeat(64) };
    await write(root, 'xforge/changes/add-feature/evidence/audit/index.json', `${JSON.stringify(index, null, 2)}\n`);
    await rm(path.join(root, 'xforge', '.audit'), { recursive: true, force: true });

    const blocked = await runCli(root, ['archive', '--change', 'add-feature'], approvalTestEnv);
    expect(blocked.code).toBe(1);
    const messages = blocked.json.diagnostics.map((item: any) => item.message).join('\n');
    expect(messages).toContain('audit:untrusted');
    expect(await exists(path.join(root, 'xforge', 'changes', 'add-feature'))).toBe(true);
  });

  it('uses relocated docs/specs and docs/changes consistently', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.project.paths = { specs: 'docs/specs', changes: 'docs/changes' };
    });
    await createCompleteSolidChange(root, 'unused');
    const { cp, mkdir } = await import('node:fs/promises');
    await mkdir(path.join(root, 'docs', 'changes'), { recursive: true });
    await cp(path.join(root, 'xforge', 'changes', 'unused'), path.join(root, 'docs', 'changes', 'relocated'), { recursive: true });
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => { gate.spec.command = [process.execPath, '-e', 'process.exit(0)']; delete gate.spec.builtin; });
    expect((await runCli(root, ['install'])).code).toBe(0);
    await advanceSolidToReadyToArchive(root, 'relocated');
    const state = await runCli(root, ['state', '--change', 'relocated'], approvalTestEnv);
    expect(state.code, JSON.stringify(state.json.diagnostics, null, 2)).toBe(0);
    expect(state.json.data.project.paths).toMatchObject({ specs: { value: 'docs/specs' }, changes: { value: 'docs/changes' } });
    const archived = await runCli(root, ['archive', '--change', 'relocated'], approvalTestEnv);
    expect(archived.code).toBe(0);
    expect(await exists(path.join(root, 'docs', 'specs', 'widget', 'spec.md'))).toBe(true);
    expect((await readdir(path.join(root, 'docs', 'changes', 'archive')))[0]).toMatch(/-relocated$/);
  });
});
