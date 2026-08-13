import { describe, expect, it } from 'vitest';
import { changeYaml, fixture, runCli, updateYaml, write, yamlFile } from '../helpers.js';

describe('shipped audit defaults', () => {
  /*
   * A default install used to drive a Major Change through propose → verify, collect two human
   * approvals, and then fail archive forever on `audit:remote-pending`: major.yaml declared
   * `remoteDelivery: required` and the Manifest listed `major` in `audit.remote.requiredFor`, while
   * `XFORGE_AUDIT_ENDPOINT` is unset on a fresh project, so every event stayed undelivered and
   * `xforge audit retry` had nowhere to send it. Remote delivery is an enterprise opt-in; the
   * shipped default must be archivable without an HTTP receiver.
   */
  it('never requires remote audit delivery a fresh project cannot satisfy', async () => {
    const root = await fixture();
    const manifest = await yamlFile<any>(root, 'xforge/manifest.yaml');
    expect(manifest.audit.remote.requiredFor).toEqual([]);
    /* The opt-in itself stays documented: the env-var names are the whole contract. */
    expect(manifest.audit.remote.endpointEnv).toBe('XFORGE_AUDIT_ENDPOINT');

    for (const name of ['quick', 'solid', 'major']) {
      const flow = await yamlFile<any>(root, `xforge/flows/${name}.yaml`);
      expect(flow.governance.audit.remoteDelivery, name).toBe('optional');
      expect(flow.terminal.archive.auditPolicy?.remoteDelivery ?? 'optional', name).toBe('optional');
      /* `xforge audit verify` reads the Flow block while archive prefers the terminal one; when
         they disagree the command calls a Change complete that archive then rejects. */
      expect(flow.terminal.archive.auditPolicy?.requiredEventTypes ?? flow.governance.audit.requiredEventTypes, name)
        .toEqual(flow.governance.audit.requiredEventTypes);
    }
  });
});

describe('governance validation', () => {
  it('rejects quick for cross-module, non-low, or critical-impact Changes', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/manifest.yaml', (manifest) => {
      manifest.project.layout = 'monorepo';
      manifest.project.modules.push({ id: 'api', path: 'services/api', kind: 'service' });
    });
    await write(root, 'xforge/changes/unsafe/change.yaml', changeYaml('quick', {
      classification: { risk: 'high', security: true, privacy: false, publicApi: false, dataMigration: false },
      scope: { modules: ['root', 'api'], paths: ['src/**', 'services/api/**'] },
    }));
    const result = await runCli(root, ['check', '--change', 'unsafe']);
    expect(result.code).toBe(1);
    expect(result.json.diagnostics.map((item: any) => item.code)).toEqual(expect.arrayContaining(['XFORGE_FLOW_TOO_WEAK', 'XFORGE_FLOW_REQUIRED_POLICY']));
    expect(result.json.changes).toEqual([]);
  });

  it('returns stable diagnostics for a missing Constitution and explicit Rule conflict', async () => {
    const root = await fixture();
    const { rename } = await import('node:fs/promises');
    await rename(`${root}/xforge/constitution.md`, `${root}/xforge/constitution.missing`);
    const missing = await runCli(root, ['check']);
    expect(missing.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CONSTITUTION_MISSING');

    const conflictRoot = await fixture();
    await write(conflictRoot, 'xforge/scaffold/rules/acme-conflict.yaml', [
      'apiVersion: xforge.dev/v1alpha1', 'kind: Rule', 'metadata:', '  name: acme-conflict', '  version: 1',
      'spec:', '  level: mandatory', '  instruction: Override the Constitution.', '  constitutionCompatibility: conflict', '  gate: structure', '',
    ].join('\n'));
    await updateYaml(conflictRoot, 'xforge/manifest.yaml', (manifest) => { manifest.scaffold.rules = ['acme-conflict']; });
    const conflict = await runCli(conflictRoot, ['check']);
    expect(conflict.json.diagnostics.map((item: any) => item.code)).toContain('XFORGE_CONSTITUTION_RULE_CONFLICT');
  });

  it('requires install to refresh locked content before checks can execute', async () => {
    const root = await fixture();
    await updateYaml(root, 'xforge/scaffold/gates/unit-tests.yaml', (gate) => {
      gate.spec.command = [process.execPath, '-e', 'process.exit(0)'];
    });
    const stale = await runCli(root, ['check']);
    expect(stale.code).toBe(1);
    expect(stale.json.diagnostics.map((item: any) => item.code)).toEqual(expect.arrayContaining(['XFORGE_LOCK_RESOURCES_MISMATCH', 'XFORGE_LOCK_STALE']));
    expect(stale.json.changes).toEqual([]);
    expect((await runCli(root, ['install'])).code).toBe(0);
    expect((await runCli(root, ['check'])).code).toBe(0);
  });
});
