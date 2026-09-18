// design: cli §5 — CLI-36（注册表：不认得的 provider）、CLI-37（enforcement 按当前宿主算）、CLI-38（钩子命令串只来自声明）、CLI-41（投影台账与孤儿回收）；§4 — CLI-39（载荷适配按 --host 选）。
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { dirname, join } from 'node:path';
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

  it('claude gets claude-shaped answers; a host with no adapter is denied in a shape the host can read', async () => {
    // CLI-45：放行什么都不说 —— 显式 allow 会跳过宿主自己的审批提示。
    expect(await enforceRaw(p.root, 'claude', { tool_name: 'Read', tool_input: {}, cwd: p.root })).toBe('');
    const denied = JSON.parse(await enforceRaw(p.root, 'claude', { tool_name: 'Write', tool_input: { file_path: join(p.root, 'xforge', 'manifest.yaml') }, cwd: p.root })) as { hookSpecificOutput: { permissionDecision: string } };
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    // CLI-39：认不出的宿主仍然拦，且用宿主读得懂的形状说 —— 回一个它读不懂的形状等于没拦。
    const unknown = JSON.parse(await enforceRaw(p.root, 'zed', { tool_name: 'Read', tool_input: {}, cwd: p.root })) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(unknown.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(unknown.hookSpecificOutput.permissionDecisionReason).toContain('zed');
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

describe('a host config file we cannot read is left alone (CLI-23)', () => {
  const MINE = '{\n  // 我自己的权限设置\n  "permissions": { "allow": ["Bash(ls:*)"] },\n  "env": { "FOO": "bar" }\n}\n';
  let p: Project;
  const settingsPath = (): string => join(p.root, '.claude', 'settings.json');

  beforeAll(async () => {
    p = await Project.create('unreadable');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude');
    writeFileSync(settingsPath(), MINE);
  });

  it('sync writes not one byte, says why, and doctor keeps saying it', async () => {
    const r = await p.xforge('sync');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    // 覆盖它等于把人家的 permissions 与其余钩子一起删掉。
    expect(readFileSync(settingsPath(), 'utf8')).toBe(MINE);
    expect(r.env.changed).not.toContain('.claude/settings.json');
    const blocked = r.env.diagnostics.find((d) => d.code === 'XF-ASSEMBLE-013');
    expect(blocked?.severity).toBe('warning');
    expect(blocked?.message).toContain('.claude/settings.json');

    const d = await p.xforge('doctor');
    expect(d.exit).toBe(1);
    expect(d.env.diagnostics.find((x) => x.code === 'XF-ASSEMBLE-013')?.severity).toBe('blocking');
    // 钩子没装进去，enforcement 就不许说 available。
    const orient = await p.xforge('state', '--orient');
    expect((orient.env.result as { orient: { invariants: { enforcement: string } } }).orient.invariants.enforcement).toBe('unavailable');
    expect(readFileSync(settingsPath(), 'utf8')).toBe(MINE);
  });

  it('repair does not touch it either, and once it parses the hook goes in', async () => {
    const r = await p.xforge('repair');
    expect(readFileSync(settingsPath(), 'utf8')).toBe(MINE);
    expect(r.env.diagnostics.some((d) => d.code === 'XF-ASSEMBLE-013')).toBe(true);

    writeFileSync(settingsPath(), '{\n  "env": { "FOO": "bar" }\n}\n');
    expect((await p.xforge('sync')).exit).toBe(0);
    expect(enforceCommands(p)).toEqual(['xforge-enforce --host claude']);
    expect((settings(p) as unknown as { env: { FOO: string } }).env.FOO).toBe('bar');
    expect((await p.xforge('doctor')).env.diagnostics.some((d) => d.code === 'XF-ASSEMBLE-013')).toBe(false);
  });
});

describe('a hook that is installed but cannot run is not available (CLI-48)', () => {
  let p: Project;
  /** 这台机器上没装 CLI：PATH 上有 node（否则连命令都起不来），但没有 xforge-enforce。 */
  const bare = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };

  beforeAll(async () => {
    p = await Project.create('hookpath');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude');
  });

  it('装上了 ≠ 跑得起来：PATH 上没有就报 XF-ASSEMBLE-014，enforcement 说 unavailable', async () => {
    expect(enforceCommands(p)).toEqual(['xforge-enforce --host claude']);
    const orient = async (env?: Record<string, string>): Promise<string> =>
      ((await p.xforgeIn({ ...(env ? { env } : {}) }, 'state', '--orient')).env.result as { orient: { invariants: { enforcement: string } } }).orient.invariants.enforcement;

    expect(await orient()).toBe('available');
    expect(await orient(bare)).toBe('unavailable');

    const d = await p.xforgeIn({ env: bare }, 'doctor');
    expect(d.exit).toBe(1);
    const found = d.env.diagnostics.find((x) => x.code === 'XF-ASSEMBLE-014');
    expect(found?.severity).toBe('blocking');
    expect(found?.message).toContain('xforge-enforce');
    // 钩子明明在设置里，所以不该报成「不在」。
    expect(d.env.diagnostics.some((x) => x.code === 'XF-ASSEMBLE-008')).toBe(false);
    // 装好的机器上这条发现不存在。
    expect((await p.xforge('doctor')).env.diagnostics.some((x) => x.code === 'XF-ASSEMBLE-014')).toBe(false);
  });

  it('修不了它：环境与安装方式是人的事，repair 不假装修好', async () => {
    const r = await p.xforgeIn({ env: bare }, 'repair');
    expect(r.exit).toBe(1);
    expect((r.env.result as { left: Array<{ code: string }> }).left.map((x) => x.code)).toContain('XF-ASSEMBLE-014');
  });
});

describe('the ledger is a derived file, not the truth (CLI-46)', () => {
  let p: Project;
  const ledgerPath = (): string => join(p.root, 'xforge', 'hosts.yaml');
  const orphan = (): string => join(p.root, '.claude', 'skills', 'xforge-design', 'SKILL.md');

  beforeAll(async () => {
    p = await Project.create('ledgerloss');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude');
  });

  it('坏掉的台账不让 sync 与 doctor 倒下，重投一次就回来了', async () => {
    writeFileSync(ledgerPath(), 'providers: [[[bad\n');
    const d = await p.xforge('doctor');
    expect(d.exit, JSON.stringify(d.env)).toBe(0); // 只是 warning：台账丢了不等于装配坏了
    expect(d.env.diagnostics.find((x) => x.code === 'XF-ASSEMBLE-017')?.severity).toBe('warning');

    const r = await p.xforge('sync');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(r.env.diagnostics.some((x) => x.code === 'XF-ASSEMBLE-017')).toBe(true);
    expect(parse(readFileSync(ledgerPath(), 'utf8'))).toMatchObject({ version: 1 });
    expect((await p.xforge('doctor')).env.diagnostics.some((x) => x.code === 'XF-ASSEMBLE-017')).toBe(false);
  });

  it('台账被删掉之后孤儿仍然认得出来，不永久失忆', async () => {
    rmSync(join(p.root, 'xforge', 'scaffold', 'skills', 'xforge-design'), { recursive: true });
    rmSync(ledgerPath());
    expect(existsSync(orphan())).toBe(true);

    const d = await p.xforge('doctor');
    expect(d.env.diagnostics.some((x) => x.code === 'XF-ASSEMBLE-007')).toBe(true);
    const r = await p.xforge('sync');
    expect((r.env.result as { removed: string[] }).removed).toContain('.claude/skills/xforge-design/SKILL.md');
    expect(existsSync(orphan())).toBe(false);
    expect((await p.xforge('doctor')).env.diagnostics.some((x) => x.code === 'XF-ASSEMBLE-007')).toBe(false);
  });
});

describe('a shared block taken out whole is a finding, not health (CLI-47)', () => {
  let p: Project;
  const agents = (): string => join(p.root, 'AGENTS.md');

  beforeAll(async () => {
    p = await Project.create('stripped');
    await p.write('AGENTS.md', '# 我的项目\n\n这一段是人写的。\n');
    await p.xforge('init', '--flow', 'quick', '--platform', 'codex');
  });

  it('doctor 报 006，repair 补回来，块外逐字节不动', async () => {
    const withBlock = readFileSync(agents(), 'utf8');
    expect(withBlock).toContain('<!-- XFORGE:BEGIN -->');
    writeFileSync(agents(), '# 我的项目\n\n这一段是人写的。\n');

    const d = await p.xforge('doctor');
    expect(d.exit, JSON.stringify(d.env)).toBe(1);
    const found = d.env.diagnostics.find((x) => x.code === 'XF-ASSEMBLE-006');
    expect(found?.severity).toBe('blocking');
    expect(found?.message).toContain('AGENTS.md');

    const r = await p.xforge('repair');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    const after = readFileSync(agents(), 'utf8');
    expect(after).toBe(withBlock);
    expect(after.startsWith('# 我的项目\n\n这一段是人写的。\n')).toBe(true);
  });

  it('doctor 干净的树上 sync 不会有改动 —— 「说没病、下一步就改文件」不存在', async () => {
    const d = await p.xforge('doctor');
    expect(d.env.diagnostics.filter((x) => x.severity !== 'info')).toEqual([]);
    expect((await p.xforge('sync')).env.changed).toEqual([]);
  });
});
