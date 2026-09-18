// design: cli §4 — CLI-46（codex 载荷走同一套求值；补丁里取不到目标、宿主名认不出都拒绝）、CLI-47（codex 没有「问」：ask 降级成 deny，claude 保留 ask）、CLI-49（放行时两个宿主都不写 stdout）。
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Project } from '../helpers/project.js';

const patch = (root: string, body: string) => ({ tool_name: 'apply_patch', tool_input: { command: body }, cwd: root });
const bash = (root: string, command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: root });

describe('xforge-enforce --host codex', () => {
  let p: Project;
  beforeAll(async () => {
    p = await Project.create('enforce-codex');
    await p.write('package.json', '{"name":"e"}\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'quick');
  });

  it('CLI-46 patch and shell go through the same evaluation; allow says nothing at all', async () => {
    expect(await p.enforceRaw(patch(p.root, '*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch'), { host: 'codex' })).toBe('');
    expect((await p.enforce(patch(p.root, '*** Update File: xforge/changes/C-1/evidence/receipts/0001.yaml\n@@\n-x\n+y\n*** End Patch'), { host: 'codex' })).reason).toContain('XF-ENFORCE-001');
    expect((await p.enforce(bash(p.root, 'echo hi > xforge/.audit/chain.jsonl'), { host: 'codex' })).decision).toBe('deny');
  });

  it('CLI-46 a rename writes the new place too: `*** Move to:` is a write target', async () => {
    const moved = await p.enforce(patch(p.root, '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: xforge/manifest.yaml\n+x\n*** End Patch'), { host: 'codex' });
    expect(moved.decision).toBe('deny');
    expect(moved.reason).toContain('XF-ENFORCE-001');
  });

  it('CLI-46 a patch with no target at all is a parse failure, not a silent pass', async () => {
    const empty = await p.enforce(patch(p.root, '*** Begin Patch\n*** End Patch'), { host: 'codex' });
    expect(empty.decision).toBe('deny');
    expect(empty.reason).toContain('失败朝安全');
  });

  it('CLI-46 an unknown host is denied, and the reason names it', async () => {
    const other = await p.enforce({ tool_name: 'Read', tool_input: { file_path: join(p.root, 'README.md') }, cwd: p.root }, { host: 'aider' });
    expect(other.decision).toBe('deny');
    expect(other.reason).toContain('aider');
  });

  it('CLI-49 allow says nothing on either host: enforcement blocks and escalates, it never grants', async () => {
    expect(await p.enforceRaw({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'src', 'c.ts') }, cwd: p.root })).toBe('');
    expect(await p.enforceRaw(bash(p.root, 'ls'), { host: 'codex' })).toBe('');
    const claude = await p.enforce({ tool_name: 'Read', tool_input: { file_path: join(p.root, 'xforge', 'manifest.yaml') }, cwd: p.root });
    expect(claude).toEqual({ decision: 'allow', reason: '' });
  });

  it('CLI-47 a policy that wants a human: codex has no ask, so it becomes a deny; claude still asks', async () => {
    await p.write(
      'xforge/scaffold/policies/ask-on-src.yaml',
      ['name: ask-on-src', 'rules:', '  - effect: ask', '    tools: [write, edit, shell]', '    paths: ["src/**"]', '    message: "改源码前先问人。"', ''].join('\n'),
    );
    const manifestPath = join(p.root, 'xforge', 'manifest.yaml');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replace('    - protected-governance', '    - protected-governance\n    - ask-on-src'));

    const codex = await p.enforce(patch(p.root, '*** Begin Patch\n*** Add File: src/b.ts\n+x\n*** End Patch'), { host: 'codex' });
    expect(codex.decision).toBe('deny');
    expect(codex.reason).toContain('改源码前先问人');
    expect(codex.reason).toContain('要人点头');

    const claude = await p.enforce({ tool_name: 'Write', tool_input: { file_path: join(p.root, 'src', 'b.ts') }, cwd: p.root });
    expect(claude.decision).toBe('ask');
  });
});
