import { describe, expect, it } from 'vitest';
import { matchPathGlob, matchPathGlobFallback, matchWildcard } from '../../src/core/governance.js';
import { parseMcpTool, resolveToolCapability, targetToolNames, unknownToolDecision, unknownToolGap } from '../../src/core/tool-capability.js';
import type { Manifest } from '../../src/types.js';

function manifest(unknownToolPolicy?: 'allow' | 'ask' | 'deny'): Manifest {
  return { runtime: unknownToolPolicy ? { unknownToolPolicy } : undefined } as unknown as Manifest;
}

describe('tool -> capability resolution', () => {
  it('resolves MCP tools to mcp before any name heuristic', () => {
    for (const name of ['mcp__filesystem__read_file', 'mcp__github__write_file', 'MCP:linear.create_issue', 'mcp__db__delete_row']) {
      expect(resolveToolCapability('claude', name)).toEqual({ capability: 'mcp', hint: null, source: 'mcp' });
    }
  });

  it('parses the MCP server and tool out of the namespaced name', () => {
    expect(parseMcpTool('mcp__filesystem__read_file')).toEqual({ server: 'filesystem', tool: 'read_file' });
    expect(parseMcpTool('MCP:linear.create_issue')).toEqual({ server: 'linear', tool: 'create_issue' });
    expect(parseMcpTool('Read')).toBeNull();
  });

  it('classifies well-known tools per target', () => {
    expect(resolveToolCapability('claude', 'Write').capability).toBe('fs.write');
    expect(resolveToolCapability('claude', 'Read').capability).toBe('fs.read');
    expect(resolveToolCapability('claude', 'Bash').capability).toBe('shell');
    expect(resolveToolCapability('claude', 'Task').capability).toBe('subagent');
    expect(resolveToolCapability('claude', 'WebFetch').capability).toBe('network');
    expect(resolveToolCapability('codex', 'apply_patch').capability).toBe('fs.write');
    expect(resolveToolCapability('codex', 'exec_command').capability).toBe('shell');
    expect(resolveToolCapability('opencode', 'patch').capability).toBe('fs.write');
    expect(resolveToolCapability('cursor', 'Delete').capability).toBe('fs.write');
    expect(resolveToolCapability('github-copilot', 'str_replace_editor').capability).toBe('fs.write');
  });

  it('marks plan/todo bookkeeping tools as outside the capability model', () => {
    expect(resolveToolCapability('claude', 'TodoWrite').capability).toBe('none');
    expect(resolveToolCapability('codex', 'update_plan').capability).toBe('none');
    // TodoWrite renamed and split. Unmapped, these asked -- and a headless run answers an ask with a
    // denial, so the Agent lost its task list on every Stage that tried to keep one.
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop']) {
      expect(resolveToolCapability('claude', name), name).toEqual({ capability: 'none', hint: null, source: 'table' });
    }
  });

  it('treats invoking a Skill like a slash command, not as an unknown tool', () => {
    // XForge's own Skills are invoked through this tool, so an ask here is an ask on the product's
    // own entry point.
    expect(resolveToolCapability('claude', 'Skill')).toEqual({ capability: 'none', hint: null, source: 'table' });
  });

  it('governs deferred agent work as subagent, not as bookkeeping', () => {
    // Scheduling a run for later, or addressing one to a session elsewhere, still gets an Agent
    // running: that is what makes it policy-worthy, not what exempts it.
    for (const name of ['Workflow', 'CronCreate', 'CronDelete', 'SendMessage']) {
      expect(resolveToolCapability('claude', name).capability, name).toBe('subagent');
    }
    expect(resolveToolCapability('claude', 'CronList').capability).toBe('none');
  });

  /*
   * Every tool the host actually offers resolves from the table, one way or another.
   *
   * The roster is the surface Claude Code exposed to a live-engine run, read out of the `tools`
   * array in the `system/init` record its transcript opens with -- refresh it from
   * `tests/.tmp/live-engine-results/*-transcript.jsonl` after a run against a newer host.
   *
   * What this asserts is `source: 'table'`, not a particular capability: an entry may legitimately
   * resolve to `unknown` (`EnterWorktree` does, deliberately). The failure it exists to catch is
   * `source: 'heuristic'` or `'unrecognised'` -- a name nobody has classified, which the dispatcher
   * then puts to `unknownToolPolicy`. That failure is silent per call and was worth 124 denials
   * across this repository's transcripts before anyone counted them, because the only symptom is an
   * Agent quietly doing without.
   */
  it('classifies every tool the host offers, so an unmapped name fails here and not in a live run', () => {
    const hostRoster = [
      'Task', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit', 'EnterWorktree',
      'ExitWorktree', 'NotebookEdit', 'Read', 'ReportFindings', 'ScheduleWakeup', 'SendMessage',
      'Skill', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
      'WebFetch', 'WebSearch', 'Workflow', 'Write',
    ];
    const unclassified = hostRoster.filter((name) => resolveToolCapability('claude', name).source !== 'table');
    expect(unclassified).toEqual([]);
  });

  it('treats invoking a slash command as outside the capability model, not an unknown tool', () => {
    // A slash-command invocation is not itself a governable resource (unlike whatever tool calls
    // its body eventually makes), so it should not fall through to unknownToolPolicy's ask/deny.
    expect(resolveToolCapability('claude', 'SlashCommand')).toEqual({ capability: 'none', hint: null, source: 'table' });
  });

  it('routes discovery tools whose resource is a query, not a path, to unknown', () => {
    for (const name of ['Grep', 'Glob', 'Search', 'grep_search', 'semantic_search']) {
      expect(resolveToolCapability('claude', name).capability).toBe('unknown');
    }
  });

  it('keeps the name heuristic as a non-authoritative hint only', () => {
    const resolved = resolveToolCapability('claude', 'SuperEditor');
    expect(resolved.capability).toBe('unknown');
    expect(resolved.hint).toBe('fs.write');
    expect(resolved.source).toBe('heuristic');
    expect(resolveToolCapability('claude', 'Zork')).toEqual({ capability: 'unknown', hint: null, source: 'unrecognised' });
  });

  it('exposes the same per-target tool names used for resolution, for consumers that need the raw list', () => {
    const cursorNames = targetToolNames('cursor');
    expect(cursorNames).toEqual(expect.arrayContaining(['shell', 'read', 'write', 'edit', 'delete', 'task', 'mcp', 'fetch']));
    for (const name of cursorNames) {
      /* The bare name 'mcp' is recognised by isMcpTool() itself (a documented wildcard MCP
         reference), which resolveToolCapability consults before the per-target table — so it
         resolves via that earlier path, not the table, even though it is also a table entry. */
      expect(resolveToolCapability('cursor', name).source).toBe(name === 'mcp' ? 'mcp' : 'table');
    }
  });

  it('defaults the unknown-tool decision to ask and honours the manifest override', () => {
    expect(unknownToolDecision(manifest())).toBe('ask');
    expect(unknownToolDecision(manifest('deny'))).toBe('deny');
    expect(unknownToolDecision(manifest('allow'))).toBeNull();
    expect(unknownToolGap('Grep')).toBe('unknown-tool:Grep');
  });
});

describe('path glob semantics', () => {
  const cases: Array<[string, string, boolean]> = [
    // P1-6: `*` must not cross a path separator.
    ['src/**', 'srcfoo/x', false],
    ['src/*', 'src/a/b.ts', false],
    ['src/*', 'src/a.ts', true],
    ['src/**', 'src/a/b/c.ts', true],
    ['src/**', 'src', true],
    ['**', 'a/b/c', true],
    ['**/*.ts', 'a/b/c.ts', true],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    // shipped `protected-files` policy patterns
    ['xforge/constitution.md', 'xforge/constitution.md', true],
    ['xforge/specs/**', 'xforge/specs/foo.md', true],
    ['xforge/specs/**', 'xforge/specs/auth/spec.md', true],
    ['xforge/specs/**', 'xforge/specsfoo/foo.md', false],
    ['xforge/manifest.yaml', 'xforge/manifest.yaml', true],
    ['xforge/manifest.yaml', 'xforge/manifest.yaml.bak', false],
    // dotfiles are matched like any other name
    ['**', '.claude/settings.json', true],
  ];

  it('matches per the documented semantics', () => {
    for (const [pattern, value, expected] of cases) {
      expect(matchPathGlob(pattern, value), `${pattern} vs ${value}`).toBe(expected);
    }
  });

  it('keeps the dependency-free fallback in agreement with the reference engine', () => {
    for (const [pattern, value, expected] of cases) {
      expect(matchPathGlobFallback(pattern, value), `fallback ${pattern} vs ${value}`).toBe(expected);
    }
  });

  it('normalises backslashes and leading ./ before matching', () => {
    expect(matchPathGlob('xforge/specs/**', 'xforge\\specs\\foo.md')).toBe(true);
    expect(matchPathGlob('xforge/manifest.yaml', './xforge/manifest.yaml')).toBe(true);
  });

  it('leaves non-path patterns on loose wildcard semantics', () => {
    expect(matchWildcard('rm -rf *', 'rm -rf /tmp/x')).toBe(true);
    expect(matchWildcard('*.example.com', 'api.example.com')).toBe(true);
    expect(matchWildcard('mcp__github__*', 'mcp__github__create_issue')).toBe(true);
  });
});
