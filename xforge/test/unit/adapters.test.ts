import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilityMatrix, getAdapter } from '../../src/adapters/index.js';
import { TARGETS } from '../../src/constants.js';
import { xforgeRoot } from '../helpers.js';

describe('Adapter golden mapping', () => {
  it('locks all five protocol-1 installation paths and capabilities', async () => {
    const golden = JSON.parse(await readFile(path.join(xforgeRoot, 'test', 'fixtures', 'golden', 'adapters.json'), 'utf8'));
    const actual = Object.fromEntries(TARGETS.map((target) => {
      const adapter = getAdapter(target);
      const commandPath = adapter.commandPath('xforge-explore');
      return [target, {
        skill: `${adapter.skillDirectory('xforge-explore')}/SKILL.md`,
        command: commandPath,
        capability: adapter.capability,
      }];
    }));
    expect(actual).toEqual(golden);
    expect(capabilityMatrix([...TARGETS])).toEqual(Object.fromEntries(TARGETS.map((target) => [target, golden[target].capability])));
  });

  it('keeps command files as thin Skill entry points', () => {
    for (const target of TARGETS) {
      const output = getAdapter(target).renderCommand('xforge-verify');
      if (target === 'codex') expect(output).toBeNull();
      else {
        expect(output).toContain('xforge-verify');
        expect(output).toContain('xforge state');
        expect(output!.length).toBeLessThan(600);
      }
    }
  });

  it('renders the three sub-Agent contracts only for native Agent targets', async () => {
    const worker = {
      apiVersion: 'xforge.dev/v1alpha1',
      kind: 'Agent' as const,
      metadata: { name: 'worker', version: 1 },
      spec: {
        role: 'Isolated work-package implementation worker',
        instructions: 'worker.md',
        skills: ['xforge-apply'],
        tools: { allow: ['read', 'search', 'write', 'test'] },
        delegation: { callableBy: ['main'], maxConcurrency: 3 },
        model: { class: 'default', fallback: 'default' },
      },
    };
    for (const target of TARGETS) {
      const adapter = getAdapter(target);
      const output = adapter.renderAgent(worker, 'Execute exactly one assigned work package.');
      if (adapter.capability.agents === 'native') {
        expect(adapter.agentPath('worker')).not.toBeNull();
        expect(output).toContain('Execute exactly one assigned work package.');
        expect(output).toContain('Max concurrency: 3');
      } else {
        expect(adapter.agentPath('worker')).toBeNull();
        expect(output).toBeNull();
      }
    }
  });
});
