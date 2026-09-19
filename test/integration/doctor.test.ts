// design: cli §5.4 — CLI-42：doctor 的发现表逐条，干净的树是 0，changed 恒空，升级在途只报哨兵。
import { beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project, repoRoot, type Result } from '../helpers/project.js';

const codes = (r: Result): string[] => r.env.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.code);
const result = (r: Result): { checks: number; problems: number; providers: Array<{ id: string; enforcement: string; installed: boolean; issues: string[] }> } =>
  r.env.result as { checks: number; problems: number; providers: Array<{ id: string; enforcement: string; installed: boolean; issues: string[] }> };

describe('doctor (CLI-42)', () => {
  let p: Project;

  beforeEach(async () => {
    p = await Project.create('doctor');
    await p.write('AGENTS.md', '# mine\n\nkeep\n');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude', '--platform', 'codex');
  });

  it('a clean tree is exit 0 with no problems, and it never writes', async () => {
    const r = await p.xforgeIn({ env: { XFORGE_DETECT: 'claude:2.1.0,codex:none' } }, 'doctor');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(r.env.changed).toEqual([]);
    const res = result(r);
    expect(res.problems).toBe(0);
    expect(res.providers.find((x) => x.id === 'claude')).toMatchObject({ enforcement: 'available', installed: true });
    // codex 能执法，但钩子要人在它的 /hooks 里放行一次，那一步我们看不见（D8）。
    expect(res.providers.find((x) => x.id === 'codex')).toMatchObject({ enforcement: 'unavailable', installed: false });
    // 只剩 codex 那条「要人在 /hooks 里放行」的提醒；它是事实，不是树上的问题。
    expect(r.env.diagnostics.every((d) => d.severity === 'info' || d.code === 'XF-ASSEMBLE-014')).toBe(true);
  });

  it('XF-ASSEMBLE-006 a projection that is gone, or edited by hand', async () => {
    rmSync(join(p.root, '.claude', 'skills', 'xforge-design', 'SKILL.md'));
    const missing = await p.xforge('doctor');
    expect(missing.exit).toBe(1);
    expect(codes(missing)).toContain('XF-ASSEMBLE-006');
    expect(missing.env.changed).toEqual([]);
    await p.xforge('sync');
    const path = join(p.root, '.codex', 'skills', 'xforge', 'SKILL.md');
    writeFileSync(path, readFileSync(path, 'utf8') + '\n人手加的一句\n');
    const drifted = await p.xforge('doctor');
    expect(codes(drifted)).toContain('XF-ASSEMBLE-006');
    expect(result(drifted).providers.find((x) => x.id === 'codex')?.issues).toContain('XF-ASSEMBLE-006');
  });

  it('XF-ASSEMBLE-007 an orphan the ledger still remembers', async () => {
    const dir = join(p.root, 'xforge', 'scaffold', 'skills', 'xforge-extra');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL_cn.md'), '---\nname: xforge-extra\ndescription: x\n---\n\n# x\n');
    await p.xforge('sync');
    rmSync(dir, { recursive: true, force: true }); // 脚手架没了，宿主上的还在：孤儿
    const r = await p.xforge('doctor');
    expect(codes(r)).toContain('XF-ASSEMBLE-007');
    expect(r.env.diagnostics.find((d) => d.code === 'XF-ASSEMBLE-007')?.severity).toBe('warning');
    expect(r.exit).toBe(0); // 只是不整洁，不是拦不住
  });

  it('XF-ASSEMBLE-008 the hook is not where the host reads it', async () => {
    writeFileSync(join(p.root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
    const r = await p.xforge('doctor');
    expect(r.exit).toBe(1);
    expect(codes(r)).toContain('XF-ASSEMBLE-008');
    expect(result(r).providers.find((x) => x.id === 'claude')?.enforcement).toBe('unavailable');
    expect(r.env.next[0]?.command).toBe('xforge repair');
  });

  it('XF-ASSEMBLE-010 a marker block a person broke is never touched by the machine', async () => {
    writeFileSync(join(p.root, 'AGENTS.md'), '# mine\n<!-- XFORGE:BEGIN -->\nhalf\n');
    const r = await p.xforge('doctor');
    expect(r.exit).toBe(1);
    const broken = r.env.diagnostics.find((d) => d.code === 'XF-ASSEMBLE-010');
    expect(broken?.severity).toBe('blocking');
    expect(broken?.remedy?.command).toBeUndefined(); // 只能人处理
  });

  it('XF-ASSEMBLE-009 the scaffold is older than the CLI, and XF-ASSEMBLE-005 a provider nobody knows', async () => {
    const manifestPath = join(p.root, 'xforge', 'manifest.yaml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(/scaffold:\n  version: .*\n/, 'scaffold:\n  version: 0.0.1\n').replace('platforms:', 'platforms:\n  - zed'));
    const r = await p.xforge('doctor');
    expect(codes(r)).toEqual(expect.arrayContaining(['XF-ASSEMBLE-009', 'XF-ASSEMBLE-005']));
    expect(r.env.diagnostics.find((d) => d.code === 'XF-ASSEMBLE-009')?.severity).toBe('warning');
    expect(r.env.diagnostics.find((d) => d.code === 'XF-ASSEMBLE-005')?.severity).toBe('blocking');
    expect(r.exit).toBe(1);
  });

  it('while an update is in flight it says only that', async () => {
    const payload = await mkdtemp(join(tmpdir(), 'xforge-payload-'));
    cpSync(join(repoRoot, 'scaffold'), payload, { recursive: true });
    expect((await p.xforge('update', '--payload', payload, '--to', '9.9.9')).exit).toBe(0);
    expect(existsSync(join(p.root, 'xforge', '.upgrade'))).toBe(true);
    const r = await p.xforge('doctor');
    expect(codes(r)).toEqual(['XF-ASSEMBLE-001']);
    expect(r.exit).toBe(1);
    expect(result(r).providers).toEqual([]);
  });
});
