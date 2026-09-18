// design: cli §5.5 — doctor：宿主在场、投影新鲜、能力兑现、骨架完整、残留、版本；只读；CLI-48（读不懂的钩子文件不动，报 XF-DOCTOR-003）。
import { beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { Project, repoRoot } from '../helpers/project.js';

type Diag = { code: string; message: string };

describe('doctor', () => {
  let p: Project;
  /** 一台「只装了这几样」的机器：探测看的是这个 HOME 与这个 PATH，不是基准机的。 */
  let machine: { home: string; bin: string; path: string };

  const codes = (env: { diagnostics?: Diag[] }): string[] => (env.diagnostics ?? []).map((d) => d.code);
  const results = (env: { result: unknown }): Array<{ id: string; status: string; detail?: string }> =>
    (env.result as { results: Array<{ id: string; status: string; detail?: string }> }).results;

  /**
   * 机器上有什么，就造什么：PATH 只有这个假 bin 目录（外加 node 自己所在的那一层，不然跑不起来），
   * 不含真实 PATH —— 否则基准机上装了什么，测试就跟着变。
   */
  const machineWith = (binaries: string[]): { home: string; bin: string; path: string } => {
    const home = mkdtempSyncDir();
    const bin = mkdtempSyncDir();
    for (const b of binaries) {
      writeFileSync(join(bin, b), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, b), 0o755);
    }
    return { home, bin, path: [bin, dirname(process.execPath)].join(delimiter) };
  };

  /**
   * 会话变量会让宿主「确定在场」，那一路证据盖过 PATH —— 这里测的是探测本身，
   * 所以把当前进程的会话变量清掉（不然在 Claude Code 里跑测试，claude 永远在场）。
   */
  const doctor = (env: { home: string; path: string }, ...args: string[]) => {
    const clean: Record<string, string> = { HOME: env.home, PATH: env.path, NO_COLOR: '1' };
    for (const name of ['XFORGE_ROOT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_HOME', 'CI']) clean[name] = '';
    return p.xforgeIn({ env: clean }, 'doctor', ...args);
  };

  beforeAll(async () => {
    p = await Project.create('doctor');
    await p.write('package.json', '{"name":"d"}\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'quick');
    // 装了 claude、也装了钩子命令的机器：这是「一切正常」的那台。
    machine = machineWith(['claude', 'xforge-enforce']);
  });

  it('a tree nobody touched since init is clean, and the six checks say so (CLI-39)', async () => {
    const r = await doctor(machine);
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(r.env.ok).toBe(true);
    expect(results(r.env).map((c) => c.id)).toEqual(['host', 'projection', 'capability', 'scaffold', 'residue', 'version']);
    expect(results(r.env).every((c) => c.status === 'ok')).toBe(true);
    expect(r.env.diagnostics).toEqual([]);
    expect(r.env.changed).toEqual([]);
  });

  it('does not write a byte: every file keeps its mtime (CLI-41)', async () => {
    const snapshot = (dir: string, out: Record<string, number> = {}): Record<string, number> => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) snapshot(path, out);
        else out[relative(p.root, path)] = statSync(path).mtimeMs;
      }
      return out;
    };
    const before = snapshot(p.root);
    const r = await doctor(machine);
    expect(r.exit).toBe(0);
    expect(snapshot(p.root)).toEqual(before);
  });

  it('a hand-edited projection is XF-DOCTOR-002, and sync clears it (CLI-40)', async () => {
    const skill = join(p.root, '.claude', 'skills', 'xforge', 'SKILL.md');
    writeFileSync(skill, readFileSync(skill, 'utf8') + '\n我自己加的\n');
    const dirty = await doctor(machine);
    expect(dirty.exit).toBe(1);
    expect(dirty.env.ok).toBe(false);
    expect(codes(dirty.env)).toEqual(['XF-DOCTOR-002']);
    expect((dirty.env.result as { problems: number }).problems).toBe(1);
    expect(results(dirty.env).find((c) => c.id === 'projection')?.status).toBe('fail');
    expect(dirty.env.next?.[0]?.command).toBe('xforge sync');

    await p.xforge('sync');
    const clean = await doctor(machine);
    expect(clean.exit).toBe(0);
    expect(results(clean.env).find((c) => c.id === 'projection')).toEqual({ id: 'projection', status: 'ok' });
  });

  it('a host the manifest picked but this machine does not have is XF-DOCTOR-001', async () => {
    const bare = machineWith(['xforge-enforce']); // 没有 claude，也没有 ~/.claude
    const r = await doctor(bare, '--platform', 'claude');
    expect(r.exit).toBe(1);
    expect(codes(r.env)).toEqual(['XF-DOCTOR-001']);
    expect(results(r.env).find((c) => c.id === 'host')?.detail).toContain('claude');
  });

  it('a hook nobody can run is XF-DOCTOR-003 — declared enforcement has to be real', async () => {
    const noEnforce = machineWith(['claude']);
    const r = await doctor(noEnforce);
    expect(r.exit).toBe(1);
    expect(codes(r.env)).toEqual(['XF-DOCTOR-003']);
    expect(r.env.diagnostics?.[0]?.message).toContain('xforge-enforce');
  });

  it('CLI-48 a hook file nobody can parse keeps every byte, and doctor names it (XF-DOCTOR-003)', async () => {
    const project = await Project.create('doctor-hookfile');
    await project.write('package.json', '{"name":"h"}\n');
    project.commit('seed');
    await project.xforge('init', '--flow', 'quick', '--platform', 'codex');
    const hooksPath = join(project.root, '.codex', 'hooks.json');
    const broken = '{ 这不是 JSON\n';
    writeFileSync(hooksPath, broken); // 别人的文件被改坏了：我们不动它，钩子因此没装进去

    const codexMachine = machineWith(['codex', 'xforge-enforce']);
    const env = { HOME: codexMachine.home, PATH: codexMachine.path, NO_COLOR: '1', CODEX_SANDBOX: '', CODEX_HOME: '', CI: '' };
    const again = await project.xforgeIn({ env }, 'sync');
    expect(again.exit, JSON.stringify(again.env)).toBe(0);
    expect(readFileSync(hooksPath, 'utf8')).toBe(broken);

    const d = await project.xforgeIn({ env }, 'doctor');
    expect(d.exit).toBe(1);
    expect(codes(d.env)).toEqual(['XF-DOCTOR-003']);
    expect(d.env.diagnostics?.[0]?.message).toContain('.codex/hooks.json');
  });

  it('a skill whose source file is gone is XF-DOCTOR-004 — sync would just stop projecting it', async () => {
    const project = await Project.create('doctor-scaffold');
    await project.xforge('init', '--flow', 'quick');
    rmSync(join(project.root, 'xforge', 'scaffold', 'skills', 'xforge-check', 'SKILL_cn.md'));
    const d = await project.xforgeIn({ env: { HOME: machine.home, PATH: machine.path } }, 'doctor');
    expect(d.exit).toBe(1);
    expect(codes(d.env)).toContain('XF-DOCTOR-004');
    expect(d.env.diagnostics?.find((x) => x.code === 'XF-DOCTOR-004')?.message).toContain('SKILL_cn.md');
  });

  it('an upgrade left in flight is XF-DOCTOR-005, and the sentinel lets doctor through', async () => {
    const project = await Project.create('doctor-residue');
    await project.write('package.json', '{"name":"r"}\n');
    project.commit('seed');
    await project.xforge('init', '--flow', 'quick');
    mkdirSync(join(project.root, 'xforge', '.upgrade'), { recursive: true });
    writeFileSync(join(project.root, 'xforge', '.upgrade', 'status.yaml'), 'from: 1.0.1\nto: 9.9.9\n');
    const d = await project.xforgeIn({ env: { HOME: machine.home, PATH: machine.path } }, 'doctor');
    expect(d.exit, JSON.stringify(d.env)).toBe(1); // 哨兵拦别的命令，不拦它
    expect(codes(d.env)).toEqual(['XF-DOCTOR-005']);
    expect(d.env.next?.[0]?.command).toBe('xforge sync');
  });

  it('an older scaffold is only XF-DOCTOR-006: info, exit 0, nothing blocked', async () => {
    const project = await Project.create('doctor-version');
    await project.write('package.json', '{"name":"v"}\n');
    project.commit('seed');
    await project.xforge('init', '--flow', 'quick');
    const manifestPath = join(project.root, 'xforge', 'manifest.yaml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(/scaffold:\n  version: .*\n/, 'scaffold:\n  version: 0.0.1\n'));
    const d = await project.xforgeIn({ env: { HOME: machine.home, PATH: machine.path } }, 'doctor');
    expect(d.exit).toBe(0); // info 不改退出码
    expect(d.env.ok).toBe(true);
    expect(codes(d.env)).toEqual(['XF-DOCTOR-006']);
    expect(results(d.env).find((c) => c.id === 'version')?.detail).toContain('0.0.1');
    expect(d.env.next?.[0]?.command).toBe('xforge update');
  });

  it('an unknown --platform is a usage error, not a silent skip', async () => {
    const r = await doctor(machine, '--platform', 'cursor');
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('cursor');
  });

  it('the dictionary explains every code it can emit', async () => {
    const r = await p.xforge('explain', 'XF-DOCTOR-004');
    expect(r.exit).toBe(0);
    expect((r.env.result as { meaning: string }).meaning).toContain('integrity.yaml');
    expect(statSync(join(repoRoot, 'diagnostics', 'XF-DOCTOR-006.yaml')).isFile()).toBe(true);
  });
});

function mkdtempSyncDir(): string {
  return mkdtempSync(join(tmpdir(), 'xforge-machine-'));
}
