import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeYaml, createCompleteSolidChange, fixture, runCli, updateYaml, write } from '../helpers.js';

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
    /* `local` keeps every shipped policy usable even while the enterprise-approvals McpServer is
       still the unconfigured placeholder. */
    expect(result.json.data.unusableApprovals).toEqual([]);
  });

  it('reports an approval policy whose providers are all unusable as a configuration gap', async () => {
    const root = await fixture();
    await createCompleteSolidChange(root);
    /* Drop `local` from Major's policies: the remaining provider's McpServer command is the
       shipped placeholder, so the policy can never collect an approval. */
    await updateYaml(root, 'xforge/flows/major.yaml', (flow) => {
      for (const policy of flow.governance.approvalPolicies) policy.providers = ['enterprise-approvals'];
    });
    const result = await runCli(root, ['doctor']);
    expect(result.code).toBe(0);
    expect(result.json.data.unusableApprovals.map((item: any) => item.id).sort()).toEqual(['closing-major', 'implementation-major']);
    expect(result.json.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'XFORGE_DOCTOR_APPROVAL_POLICY_UNUSABLE', severity: 'warning' }),
    ]));
    /* `--strict` escalates the gap into a failing exit code. */
    const strict = await runCli(root, ['doctor', '--strict']);
    expect(strict.code).toBe(1);
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
    expect(result.json.data.unusedFlows.map((item: any) => item.id).sort()).toEqual(['major', 'quick']);
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
