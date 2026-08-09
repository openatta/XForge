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
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => { gate.spec.command = [process.execPath, '-e', 'process.exit(0)']; });
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
  }, 15_000);

  it('blocks archive on a missing verification receipt or failed mandatory Gate', async () => {
    const incompleteRoot = await fixture();
    await createCompleteSolidChange(incompleteRoot);
    await rm(path.join(incompleteRoot, 'xforge', 'changes', 'add-feature', 'evidence', 'verification-receipt.yaml'));
    const incomplete = await runCli(incompleteRoot, ['archive', '--change', 'add-feature', '--dry-run']);
    expect(incomplete.code).toBe(1);
    expect(incomplete.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_ARCHIVE_ARTIFACTS_INCOMPLETE');

    const failedRoot = await fixture();
    await createCompleteSolidChange(failedRoot);
    await updateYaml(failedRoot, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => { gate.spec.command = [process.execPath, '-e', "const fs=require('node:fs'); process.exit(fs.existsSync('fail-gate') ? 2 : 0)"]; });
    expect((await runCli(failedRoot, ['install'])).code).toBe(0);
    await advanceSolidToReadyToArchive(failedRoot);
    await write(failedRoot, 'fail-gate', 'fail\n');
    const failed = await runCli(failedRoot, ['archive', '--change', 'add-feature'], approvalTestEnv);
    expect(failed.code).toBe(1);
    expect(failed.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_GATE_FAILED');
    expect(await exists(path.join(failedRoot, 'xforge', 'changes', 'add-feature'))).toBe(true);
    expect(await exists(path.join(failedRoot, 'xforge', 'specs', 'widget', 'spec.md'))).toBe(false);
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
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => { gate.spec.command = [process.execPath, '-e', 'process.exit(0)']; });
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
