// design: cli §5 — CLI-36（注册表：不认得的 provider）、CLI-37（enforcement 按当前宿主算）、CLI-38（钩子命令串只来自声明）；§4 — CLI-39（载荷适配按 --host 选）。
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
