import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilityMatrix, getAdapter } from '../../src/adapters/index.js';
import { TARGETS } from '../../src/constants.js';
import { targetToolNames } from '../../src/core/tool-capability.js';
import type { AgentResource, PermissionPolicyResource, RuleResource } from '../../src/types.js';
import { xforgeRoot } from '../helpers.js';

const worker: AgentResource = {
  apiVersion: 'xforge.dev/v1alpha1',
  kind: 'Agent',
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

const reviewer: AgentResource = {
  apiVersion: 'xforge.dev/v1alpha2',
  kind: 'Agent',
  metadata: { name: 'reviewer', version: 2 },
  spec: {
    role: 'Independent read-only integrated-change reviewer',
    instructions: 'reviewer.md',
    skills: ['xforge-explore'],
    tools: { allow: ['read', 'search', 'test'] },
    delegation: { callableBy: ['main'], maxConcurrency: 1 },
    model: { class: 'reasoning', fallback: 'default' },
  },
};

function policy(spec: Partial<PermissionPolicyResource['spec']> & Pick<PermissionPolicyResource['spec'], 'capability' | 'effect' | 'match'>, name = 'guard'): { id: string; value: PermissionPolicyResource; yamlPath: string } {
  return {
    id: name,
    yamlPath: `xforge/scaffold/policies/${name}.yaml`,
    value: {
      apiVersion: 'xforge.dev/v1alpha2',
      kind: 'PermissionPolicy',
      metadata: { name, version: 1 },
      spec: { reason: 'because', ...spec } as PermissionPolicyResource['spec'],
    },
  };
}

function projectGovernance(target: (typeof TARGETS)[number], policies: Array<ReturnType<typeof policy>>) {
  return getAdapter(target).renderGovernance({ policies, hooks: [] });
}

function fileAt(projection: ReturnType<typeof projectGovernance>, relative: string): any {
  const file = projection.files.find((item) => item.path === relative);
  return file ? JSON.parse(file.content.toString('utf8')) : null;
}

describe('Adapter golden mapping', () => {
  it('locks all five Protocol 2 installation paths and capabilities', async () => {
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

  it('attaches deterministic source trace metadata to rendered artifacts', () => {
    for (const target of TARGETS) {
      const adapter = getAdapter(target);
      expect(adapter.version).toBe('3');
      expect(adapter.trace('skill', 'xforge-explore', ['xforge/scaffold/skills/xforge-explore/SKILL.md'])).toEqual({
        resource: { kind: 'skill', id: 'xforge-explore' },
        sourcePaths: ['xforge/scaffold/skills/xforge-explore/SKILL.md'],
        renderVersion: `${target}:skill:3`,
      });
    }
  });

  it('renders the three sub-Agent contracts only for native Agent targets', () => {
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

// P1-4: tools.allow / model used to be prose in a `## XForge capabilities` section, so
// "Reviewer is read-only" was unenforced on four of five targets.
describe('Agent contract reaches enforceable frontmatter', () => {
  it('gives the read-only Reviewer a write-free Claude tools list and a reasoning model', () => {
    const output = getAdapter('claude').renderAgent(reviewer, 'Review the integrated change.')!;
    const frontmatter = output.split('---')[1]!;
    expect(frontmatter).toMatch(/^tools: "Read, Grep, Glob, Bash, TodoWrite"$/m);
    expect(frontmatter).not.toMatch(/\bWrite\b/);
    expect(frontmatter).not.toMatch(/\bEdit\b/);
    expect(frontmatter).toMatch(/^model: "opus"$/m);
  });

  it('gives the Worker write tools on Claude and a plain inherit model', () => {
    const frontmatter = getAdapter('claude').renderAgent(worker, 'Implement.')!.split('---')[1]!;
    expect(frontmatter).toContain('Write, Edit, NotebookEdit');
    expect(frontmatter).toMatch(/^model: "inherit"$/m);
  });

  it('maps the same contract onto each target\'s own enforcement key', () => {
    // Cursor subagents have no `tools` field; `readonly` is the documented write constraint.
    expect(getAdapter('cursor').renderAgent(reviewer, 'Review.')!).toMatch(/^readonly: true$/m);
    expect(getAdapter('cursor').renderAgent(worker, 'Implement.')!).toMatch(/^readonly: false$/m);

    // Copilot custom agents take a YAML list of documented tool aliases.
    const copilot = getAdapter('github-copilot').renderAgent(reviewer, 'Review.')!;
    expect(copilot).toContain('tools:\n  - "read"\n  - "search"\n  - "execute"\n  - "todo"');
    expect(copilot).not.toContain('- "edit"');

    // OpenCode agents enforce through a `permission:` map keyed by tool name.
    const opencode = getAdapter('opencode').renderAgent(reviewer, 'Review.')!;
    expect(opencode).toMatch(/^mode: "subagent"$/m);
    expect(opencode).toContain('  edit: "deny"');
    expect(opencode).not.toContain('  read: "deny"');

    // Codex was already correct and must stay so.
    expect(getAdapter('codex').renderAgent(reviewer, 'Review.')!).toContain('sandbox_mode = "read-only"');
  });
});

// P1-3: `.claude/rules/*.md` scopes with a `paths:` YAML array; without it the rule loads into
// every session unconditionally.
describe('Rule path scope survives projection', () => {
  const scoped: RuleResource = {
    apiVersion: 'xforge.dev/v1alpha2',
    kind: 'Rule',
    metadata: { name: 'api-contract', version: 1 },
    spec: { severity: 'must', instruction: 'Validate every API input.', scope: { paths: ['src/api/**/*.ts', 'lib/**/*.ts'] } },
  };
  const unscoped: RuleResource = {
    apiVersion: 'xforge.dev/v1alpha2',
    kind: 'Rule',
    metadata: { name: 'global', version: 1 },
    spec: { severity: 'should', instruction: 'Be careful.' },
  };

  it('emits a Claude paths array and never the unrecognised description key', () => {
    const output = getAdapter('claude').renderRule(scoped)!;
    expect(output).toContain('paths:\n  - "src/api/**/*.ts"\n  - "lib/**/*.ts"');
    expect(output).not.toContain('description:');
  });

  it('omits paths entirely for an unscoped rule so it loads unconditionally', () => {
    const output = getAdapter('claude').renderRule(unscoped)!;
    expect(output).not.toContain('paths:');
    expect(output).toContain('# global');
  });

  it('keeps the Cursor and Copilot scope keys', () => {
    expect(getAdapter('cursor').renderRule(scoped)!).toContain('globs: "src/api/**/*.ts,lib/**/*.ts"');
    expect(getAdapter('github-copilot').renderRule(scoped)!).toContain('applyTo: "src/api/**/*.ts,lib/**/*.ts"');
  });
});

describe('PermissionPolicy projection', () => {
  // P0-1: the previous output was a plural `permissions` array of {action,resource,effect},
  // which OpenCode does not recognise and silently ignores.
  it('emits a singular OpenCode permission object keyed by tool name', () => {
    const projection = projectGovernance('opencode', [
      policy({ capability: 'fs.write', effect: 'deny', match: { paths: ['xforge/specs/**'] } }, 'protect'),
      policy({ capability: 'shell', effect: 'ask', match: { commands: ['git push *'] } }, 'push'),
      policy({ capability: 'network', effect: 'allow', match: { hosts: ['registry.npmjs.org'] } }, 'net'),
    ]);
    expect(fileAt(projection, 'opencode.json')).toEqual({
      $schema: 'https://opencode.ai/config.json',
      permission: {
        bash: { 'git push *': 'ask' },
        edit: { 'xforge/specs/**': 'deny' },
        webfetch: { 'registry.npmjs.org': 'allow' },
      },
    });
  });

  it('merges policies landing on one OpenCode key with deny > ask > allow, general pattern first', () => {
    const projection = projectGovernance('opencode', [
      policy({ capability: 'fs.write', effect: 'allow', match: { paths: ['**'] } }, 'broad-allow'),
      policy({ capability: 'fs.write', effect: 'ask', match: { paths: ['xforge/specs/**'] } }, 'ask-specs'),
      policy({ capability: 'fs.write', effect: 'deny', match: { paths: ['xforge/specs/**'] } }, 'deny-specs'),
    ]);
    const edit = fileAt(projection, 'opencode.json').permission.edit;
    expect(edit).toEqual({ '**': 'allow', 'xforge/specs/**': 'deny' });
    // OpenCode resolves object rules last-match-wins, so the narrow deny must come after.
    expect(Object.keys(edit)).toEqual(['**', 'xforge/specs/**']);
  });

  it('reports rather than emits an OpenCode rule for a capability it cannot key', () => {
    const projection = projectGovernance('opencode', [policy({ capability: 'mcp', effect: 'deny', match: { mcpServers: ['filesystem'] } }, 'no-fs-mcp')]);
    expect(projection.files.map((item) => item.path)).not.toContain('opencode.json');
  });

  // P0-5 / P1-1: Claude's permissions.deny is a platform-level refusal evaluated before the
  // PreToolUse hook, so a flattened exceptActors policy would lock the Integrator out of the very
  // writes xforge-apply requires of it.
  it('withholds an exceptActors or stage-scoped policy from the Claude static deny layer', () => {
    const projection = projectGovernance('claude', [
      policy({ capability: 'fs.write', effect: 'deny', match: { paths: ['xforge/specs/**'] }, exceptActors: ['integrator'] }, 'protected-files'),
      policy({ capability: 'fs.write', effect: 'deny', match: { paths: ['migrations/**'], stages: ['apply'] } }, 'stage-scoped'),
    ]);
    const settings = fileAt(projection, '.claude/settings.json');
    expect(settings.permissions).toBeUndefined();
    // The runtime bridge, which does honour both dimensions, is still registered.
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('xforge hook dispatch');
  });

  it('still flattens an unconditional policy into the Claude static layer', () => {
    const settings = fileAt(projectGovernance('claude', [
      policy({ capability: 'fs.write', effect: 'deny', match: { paths: ['xforge/lock.yaml'] } }, 'lock'),
      policy({ capability: 'fs.read', effect: 'deny', match: { paths: ['.env'] } }, 'env'),
    ]), '.claude/settings.json');
    // Write(path) rules are accepted but never consulted by Claude Code's file permission checks.
    expect(settings.permissions.deny).toEqual(['Edit(xforge/lock.yaml)', 'Read(.env)'].sort());
  });

  // P2-1: `mcp__<server>__*` is documented, but only with a literal server segment; an unanchored
  // allow glob is skipped by Claude Code with a warning and grants nothing.
  it('emits the documented Claude MCP rule form and refuses to ship a dead allow rule', () => {
    const named = fileAt(projectGovernance('claude', [policy({ capability: 'mcp', effect: 'deny', match: { mcpServers: ['filesystem'] } }, 'no-fs')]), '.claude/settings.json');
    expect(named.permissions.deny).toEqual(['mcp__filesystem__*']);

    const wildcardDeny = fileAt(projectGovernance('claude', [policy({ capability: 'mcp', effect: 'deny', match: { mcpServers: ['*'] } }, 'no-mcp')]), '.claude/settings.json');
    expect(wildcardDeny.permissions.deny).toEqual(['mcp__*']);

    const wildcardAllow = projectGovernance('claude', [policy({ capability: 'mcp', effect: 'allow', match: { mcpServers: ['*'] } }, 'any-mcp')]);
    expect(fileAt(wildcardAllow, '.claude/settings.json')?.permissions).toBeUndefined();
    expect(wildcardAllow.diagnostics.map((item) => item.code)).toContain('XFORGE_POLICY_RULE_NOT_EXPRESSIBLE');
  });

  it('declares .claude/settings.json and opencode.json as partially owned', () => {
    const claude = projectGovernance('claude', [policy({ capability: 'fs.write', effect: 'deny', match: { paths: ['a'] } })]);
    expect(claude.files[0]!.fragment).toMatchObject({ format: 'json' });
    const opencode = projectGovernance('opencode', [policy({ capability: 'fs.write', effect: 'deny', match: { paths: ['a'] } })]);
    expect(opencode.files.find((item) => item.path === 'opencode.json')!.fragment).toMatchObject({ format: 'json' });
  });

  // The Cursor PreToolUse matcher used to be a hand-written literal that could silently go stale
  // against TARGET_TOOLS.cursor in tool-capability.ts. It must now be derived from that table: one
  // capitalised branch per real Cursor tool name, with the namespaced `mcp` entry rendered as the
  // `MCP:.*` wildcard form Cursor's own MCP tool names use.
  it('derives the Cursor PreToolUse matcher from the same tool-name table capability resolution uses', () => {
    const cursor = fileAt(projectGovernance('cursor', [policy({ capability: 'fs.write', effect: 'deny', match: { paths: ['a'] } })]), '.cursor/hooks.json');
    const matcher: string = cursor.hooks.preToolUse[0].matcher;
    const branches = matcher.split('|');
    for (const name of targetToolNames('cursor')) {
      expect(branches).toContain(name === 'mcp' ? 'MCP:.*' : `${name[0]!.toUpperCase()}${name.slice(1)}`);
    }
    expect(branches.length).toBe(new Set(branches).size);
  });
});

// P0-4: Claude Code reads CLAUDE.md, not AGENTS.md, and the CLI invocation contract lives only in
// AGENTS.md.
describe('Claude memory bootstrap', () => {
  it('projects a marker-owned CLAUDE.md that imports AGENTS.md', () => {
    const file = getAdapter('claude').bootstrap().find((item) => item.path === 'CLAUDE.md')!;
    const body = file.content.toString('utf8');
    expect(body).toContain('@AGENTS.md');
    expect(body).toContain('<!-- XFORGE:BEGIN -->');
    expect(body).toContain('<!-- XFORGE:END -->');
    expect(file.fragment).toMatchObject({ format: 'markers' });
  });

  it('does not project CLAUDE.md for any other target', () => {
    for (const target of TARGETS.filter((item) => item !== 'claude')) {
      expect(getAdapter(target).bootstrap().map((item) => item.path)).not.toContain('CLAUDE.md');
    }
  });
});
