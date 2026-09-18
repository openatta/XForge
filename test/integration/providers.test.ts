// design: cli §5 — CLI-36（注册表：不认得的 provider）、CLI-37（enforcement 按当前宿主算）、CLI-38（钩子命令串只来自声明）、CLI-41（投影台账与孤儿回收）；§4 — CLI-39（载荷适配按 --host 选）。
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { join } from 'node:path';
import { Project, repoRoot } from '../helpers/project.js';

interface Settings {
  hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> };
}

const settings = (p: Project): Settings => JSON.parse(readFileSync(join(p.root, '.claude', 'settings.json'), 'utf8')) as Settings;
const enforceCommands = (p: Project): string[] => (settings(p).hooks?.PreToolUse ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? '')).filter((c) => c.startsWith('xforge-enforce'));

/** 直接调执法入口：helper 的 enforce() 固定 --host claude，这里要换宿主。 */
async function enforceRaw(cwd: string, host: string, payload: unknown): Promise<string> {
  const child = execFile('node', [join(repoRoot, 'bin', 'xforge-enforce.js'), '--host', host], { cwd });
  child.stdin!.end(JSON.stringify(payload));
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  await new Promise<void>((res) => child.on('close', () => res()));
  return out.trim();
}

describe('provider registry (CLI-36)', () => {
  let p: Project;
  beforeAll(async () => {
    p = await Project.create('providers');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude', '--platform', 'codex');
  });

  it('a name the command line does not know is a usage error', async () => {
    const r = await p.xforge('sync', '--platform', 'zed');
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('没有 provider zed');
    expect(r.stderr).toContain('claude');
  });

  it('a name only the manifest has is XF-ASSEMBLE-005, and it points at doctor', async () => {
    const manifestPath = join(p.root, 'xforge', 'manifest.yaml');
    const before = readFileSync(manifestPath, 'utf8');
    writeFileSync(manifestPath, before.replace('platforms:', 'platforms:\n  - zed'));
    const r = await p.xforge('sync');
    expect(r.exit).toBe(1);
    expect(r.env.diagnostics[0]?.code).toBe('XF-ASSEMBLE-005');
    expect(r.env.diagnostics[0]?.remedy?.command).toBe('xforge doctor');
    writeFileSync(manifestPath, before);
  });
});

describe('enforcement is read off the host in use (CLI-37)', () => {
  let p: Project;
  const orient = async (env: Record<string, string> = {}): Promise<string> => {
    const r = await p.xforgeIn({ env }, 'state', '--orient');
    return (r.env.result as { orient: { invariants: { enforcement: string } } }).orient.invariants.enforcement;
  };

  beforeAll(async () => {
    p = await Project.create('enforcement');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude', '--platform', 'codex');
  });

  it('claude with its hook in place is available; codex on the same manifest is not', async () => {
    expect(await orient()).toBe('available');
    expect(await orient({ XFORGE_HOST: 'claude' })).toBe('available');
    expect(await orient({ XFORGE_HOST: 'codex' })).toBe('unavailable');
  });

  it('a hook that is gone is unavailable, and sync puts it back', async () => {
    const path = join(p.root, '.claude', 'settings.json');
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
    expect(await orient()).toBe('unavailable');
    await p.xforge('sync');
    expect(await orient()).toBe('available');
  });
});

describe('the hook command has one source (CLI-38)', () => {
  let p: Project;
  beforeAll(async () => {
    p = await Project.create('hookdecl');
    await p.xforge('init', '--flow', 'quick');
  });

  it('sync writes what the declaration says, and replaces an older one instead of keeping both', async () => {
    expect(enforceCommands(p)).toEqual(['xforge-enforce --host claude']);
    const decl = join(p.root, 'xforge', 'scaffold', 'hooks', 'enforce.yaml');
    writeFileSync(decl, 'name: enforce\nevents: [pre-tool-use]\ncommand: "xforge-enforce --host ${platform} --strict"\n');
    const r = await p.xforge('sync');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(enforceCommands(p)).toEqual(['xforge-enforce --host claude --strict']);
  });

  it('without a declaration nothing is projected, and sync says so', async () => {
    const decl = join(p.root, 'xforge', 'scaffold', 'hooks', 'enforce.yaml');
    writeFileSync(join(p.root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
    const { rmSync } = await import('node:fs');
    rmSync(decl);
    const r = await p.xforge('sync');
    expect(r.exit).toBe(0);
    expect(r.env.diagnostics.map((d) => d.code)).toContain('XF-ASSEMBLE-008');
    expect(r.env.diagnostics[0]?.severity).toBe('warning');
    expect(enforceCommands(p)).toEqual([]);
  });
});

describe('the payload adapter is chosen by --host (CLI-39)', () => {
  let p: Project;
  beforeAll(async () => {
    p = await Project.create('payload');
    await p.xforge('init', '--flow', 'quick');
  });

  it('claude gets claude-shaped answers; a host with no adapter is denied in the generic shape', async () => {
    const ok = JSON.parse(await enforceRaw(p.root, 'claude', { tool_name: 'Read', tool_input: {}, cwd: p.root })) as { hookSpecificOutput: { permissionDecision: string } };
    expect(ok.hookSpecificOutput.permissionDecision).toBe('allow');
    const unknown = JSON.parse(await enforceRaw(p.root, 'zed', { tool_name: 'Read', tool_input: {}, cwd: p.root })) as { decision: string; reason: string };
    expect(unknown.decision).toBe('deny');
    expect(unknown.reason).toContain('zed');
  });
});

describe('the projection ledger recovers orphans (CLI-41)', () => {
  let p: Project;
  const ledger = (): { providers: Array<{ id: string; files: Array<{ path: string; kind: string; checksum: string }> }> } =>
    parse(readFileSync(join(p.root, 'xforge', 'hosts.yaml'), 'utf8')) as { providers: Array<{ id: string; files: Array<{ path: string; kind: string; checksum: string }> }> };
  const entry = (id: string): Array<{ path: string; kind: string; checksum: string }> => ledger().providers.find((x) => x.id === id)?.files ?? [];

  beforeAll(async () => {
    p = await Project.create('ledger');
    await p.write('AGENTS.md', '# mine\n\nkeep\n');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude', '--platform', 'codex');
  });

  it('RF-37 records every projected file in a stable order, telling owned files from shared ones', () => {
    expect(ledger().providers.map((x) => x.id)).toEqual(['claude', 'codex']);
    const claude = entry('claude');
    expect(claude.find((f) => f.path === '.claude/skills/xforge/SKILL.md')?.kind).toBe('owned');
    expect(claude.find((f) => f.path === '.claude/settings.json')?.kind).toBe('shared');
    expect(entry('codex').find((f) => f.path === 'AGENTS.md')?.kind).toBe('shared');
    for (const f of claude) expect(f.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    // RF-37 provider 按 id、文件按 path 排序：台账逐字节稳定，第二次 sync 才可能没有改动。
    expect(ledger().providers.map((x) => x.id)).toEqual([...ledger().providers.map((x) => x.id)].sort());
    expect(claude.map((f) => f.path)).toEqual([...claude.map((f) => f.path)].sort());
  });

  it('a skill that goes away takes its projection with it, empty directory and all', async () => {
    const dir = join(p.root, 'xforge', 'scaffold', 'skills', 'xforge-extra');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL_cn.md'), '---\nname: xforge-extra\ndescription: x\n---\n\n# x\n');
    await p.xforge('sync');
    expect(existsSync(join(p.root, '.claude', 'skills', 'xforge-extra', 'SKILL.md'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    const r = await p.xforge('sync');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect((r.env.result as { removed: string[] }).removed).toContain('.claude/skills/xforge-extra/SKILL.md');
    expect(existsSync(join(p.root, '.claude', 'skills', 'xforge-extra'))).toBe(false);
    expect(entry('claude').some((f) => f.path.includes('xforge-extra'))).toBe(false);
    expect((await p.xforge('sync')).env.changed).toEqual([]);
  });

  it('dropping a provider from the manifest removes its files and detaches its block, byte for byte outside it', async () => {
    const manifestPath = join(p.root, 'xforge', 'manifest.yaml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(/platforms:\n(  - .*\n)+/, 'platforms:\n  - claude\n'));
    const r = await p.xforge('sync');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(existsSync(join(p.root, '.codex'))).toBe(false);
    expect(readFileSync(join(p.root, 'AGENTS.md'), 'utf8')).toBe('# mine\n\nkeep\n');
    expect(ledger().providers.map((x) => x.id)).toEqual(['claude']);
  });

  it('--platform leaves the other providers entries alone', async () => {
    const manifestPath = join(p.root, 'xforge', 'manifest.yaml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('platforms:\n  - claude\n', 'platforms:\n  - claude\n  - codex\n'));
    await p.xforge('sync');
    expect(ledger().providers.map((x) => x.id)).toEqual(['claude', 'codex']);
    const before = entry('codex');
    const r = await p.xforge('sync', '--platform', 'claude');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect((r.env.result as { removed: string[] }).removed).toEqual([]);
    expect(entry('codex')).toEqual(before);
    expect(existsSync(join(p.root, '.codex', 'skills', 'xforge', 'SKILL.md'))).toBe(true);
  });
});
