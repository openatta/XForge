// design: cli §5.6 — repair：只修「重写一遍就对」的事（重投影、从载荷补回缺的受管文件），其余原样报出来。
import { beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { Project, repoRoot } from '../helpers/project.js';
import { fileChecksum } from '../../src/model/integrity.js';
import { parse as parseYaml } from 'yaml';

type Diag = { code: string; message: string; remedy?: { command?: string; text: string } };
type RepairResult = { repaired: string[]; unfixable: Array<{ id: string; why: string }>; results: Array<{ id: string; status: string; detail?: string }>; problems: number };

describe('repair', () => {
  let p: Project;
  /** 一台「只装了这几样」的机器：探测看的是这个 HOME 与这个 PATH，不是基准机的。 */
  let machine: { home: string; bin: string; path: string };

  const codes = (env: { diagnostics?: Diag[] }): string[] => (env.diagnostics ?? []).map((d) => d.code);
  const result = (env: { result: unknown }): RepairResult => env.result as RepairResult;
  const statusOf = (env: { result: unknown }, id: string): string | undefined => result(env).results.find((r) => r.id === id)?.status;

  /** 机器上有什么就造什么：PATH 只有这个假 bin（外加 node 自己那一层，不然跑不起来），不含真实 PATH。 */
  const machineWith = (binaries: string[]): { home: string; bin: string; path: string } => {
    const home = mkdtempSync(join(tmpdir(), 'xforge-repair-home-'));
    const bin = mkdtempSync(join(tmpdir(), 'xforge-repair-bin-'));
    for (const b of binaries) {
      writeFileSync(join(bin, b), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, b), 0o755);
    }
    return { home, bin, path: [bin, dirname(process.execPath)].join(delimiter) };
  };

  /** 会话变量会让宿主「确定在场」，那一路证据盖过 PATH —— 这里测的是体检，把当前进程的会话变量清掉。 */
  const repair = (project: Project, env: { home: string; path: string }, ...args: string[]) => {
    const clean: Record<string, string> = { HOME: env.home, PATH: env.path, NO_COLOR: '1' };
    for (const name of ['XFORGE_ROOT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_HOME', 'CI']) clean[name] = '';
    return project.xforgeIn({ env: clean }, 'repair', ...args);
  };

  const scaffoldPath = (rel: string): string => join(p.root, 'xforge', 'scaffold', rel);
  const projectionPath = (rel: string): string => join(p.root, rel);

  beforeAll(async () => {
    p = await Project.create('repair');
    await p.write('package.json', '{"name":"r"}\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'quick');
    machine = machineWith(['claude', 'xforge-enforce']);
  });

  it('a clean tree is left alone: nothing repaired, nothing written, exit 0', async () => {
    const snapshot = (dir: string, out: Record<string, number> = {}): Record<string, number> => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) snapshot(path, out);
        else out[relative(p.root, path)] = statSync(path).mtimeMs;
      }
      return out;
    };
    const before = snapshot(p.root);
    const r = await repair(p, machine);
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(result(r.env).repaired).toEqual([]);
    expect(result(r.env).unfixable).toEqual([]);
    expect(r.env.changed).toEqual([]);
    expect(snapshot(p.root)).toEqual(before); // 投影是重算的，但算出来一样就不写盘
  });

  it('a hand-edited projection is rewritten, and changed names it (CLI-42)', async () => {
    const skill = projectionPath('.claude/skills/xforge/SKILL.md');
    const original = readFileSync(skill, 'utf8');
    writeFileSync(skill, `${original}\n我自己加的\n`);
    const r = await repair(p, machine);
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(result(r.env).repaired).toEqual(['projection']);
    expect(r.env.changed).toEqual(['.claude/skills/xforge/SKILL.md']);
    expect(readFileSync(skill, 'utf8')).toBe(original);
  });

  it('a deleted managed file comes back from the payload, checksum and all (CLI-43)', async () => {
    const rel = 'gates/ledgers.yaml';
    const recorded = (parseYaml(readFileSync(scaffoldPath('integrity.yaml'), 'utf8')) as { files: Record<string, string> }).files[rel]!;
    rmSync(scaffoldPath(rel));
    const r = await repair(p, machine);
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(result(r.env).repaired).toEqual(['scaffold']);
    expect(r.env.changed).toEqual([`xforge/scaffold/${rel}`]);
    expect(fileChecksum(readFileSync(scaffoldPath(rel), 'utf8'))).toBe(recorded);
  });

  it('a file edited outside the local zone is not touched — filling gaps is not overwriting (CLI-44)', async () => {
    const rel = 'gates/ledgers.yaml';
    const path = scaffoldPath(rel);
    const edited = `${readFileSync(path, 'utf8')}# 我自己加的\n`;
    writeFileSync(path, edited);
    const r = await repair(p, machine);
    expect(r.exit, JSON.stringify(r.env)).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(edited);
    expect(codes(r.env)).toContain('XF-DOCTOR-004');
    expect(result(r.env).unfixable.map((u) => u.id)).toEqual(['scaffold']);
    expect(r.env.next?.[0]?.command).toBe('xforge update');
  });

  it('a host this machine does not have stays broken, and says why (CLI-45)', async () => {
    const project = await Project.create('repair-host');
    await project.xforge('init', '--flow', 'quick');
    const bare = machineWith(['xforge-enforce']); // 没有 claude，也没有 ~/.claude
    const r = await repair(project, bare);
    expect(r.exit).toBe(1);
    expect(result(r.env).repaired).toEqual([]);
    expect(result(r.env).unfixable).toEqual([{ id: 'host', why: '装宿主不是 xforge 的事' }]);
    expect(codes(r.env)).toEqual(['XF-DOCTOR-001']);
    expect(statusOf(r.env, 'projection')).toBe('ok'); // 修不了的那项不挡别的项
  });

  it('a deleted Skill comes back and is projected in the same run', async () => {
    const project = await Project.create('repair-skill');
    await project.write('package.json', '{"name":"s"}\n');
    project.commit('seed');
    await project.xforge('init', '--flow', 'quick');
    const projected = join(project.root, '.claude', 'skills', 'xforge-check', 'SKILL.md');
    expect(existsSync(projected)).toBe(true);
    rmSync(join(project.root, 'xforge', 'scaffold', 'skills', 'xforge-check'), { recursive: true });

    const r = await repair(project, machine);
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    // residue 也在里面：Skill 一缺，它在宿主里的投影就成了没人认领的孤儿；Skill 补回来，孤儿自己没了。
    expect(result(r.env).repaired).toEqual(['scaffold', 'residue']);
    expect(statusOf(r.env, 'projection')).toBe('ok');
    expect(statusOf(r.env, 'residue')).toBe('ok');
    // 补回来就投出去：补的与投的是同一个事务，不用再等一次 sync —— 再 sync 一次什么都不该变。
    expect(readFileSync(projected, 'utf8')).toContain(readFileSync(join(project.root, 'xforge', 'scaffold', 'skills', 'xforge-check', 'SKILL_cn.md'), 'utf8').slice(0, 40));
    expect((await project.xforge('sync')).env.changed).toEqual([]);
  });

  it('a missing integrity.yaml is restored from the payload, so the next check has something to check against', async () => {
    const project = await Project.create('repair-integrity');
    await project.write('package.json', '{"name":"i"}\n');
    project.commit('seed');
    await project.xforge('init', '--flow', 'quick');
    rmSync(join(project.root, 'xforge', 'scaffold', 'integrity.yaml'));

    const r = await repair(project, machine);
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(existsSync(join(project.root, 'xforge', 'scaffold', 'integrity.yaml'))).toBe(true);
    expect(result(r.env).unfixable).toEqual([]);
  });

  it('a file the payload cannot vouch for is XF-REPAIR-001, and nothing gets written', async () => {
    const project = await Project.create('repair-nocopy');
    await project.write('package.json', '{"name":"n"}\n');
    project.commit('seed');
    await project.xforge('init', '--flow', 'quick');
    const integrity = join(project.root, 'xforge', 'scaffold', 'integrity.yaml');
    writeFileSync(integrity, `${readFileSync(integrity, 'utf8')}  gates/never-shipped.yaml: sha256:${'0'.repeat(64)}\n`);

    const r = await repair(project, machine);
    expect(r.exit).toBe(1);
    expect(codes(r.env)).toContain('XF-REPAIR-001');
    expect(r.env.diagnostics?.find((d) => d.code === 'XF-REPAIR-001')?.message).toContain('载荷里没有副本');
    expect(existsSync(join(project.root, 'xforge', 'scaffold', 'gates', 'never-shipped.yaml'))).toBe(false);
    expect(statusOf(r.env, 'scaffold')).toBe('fail');
  });

  it('an upgrade in flight blocks it — repair writes, unlike doctor', async () => {
    const project = await Project.create('repair-sentinel');
    await project.write('package.json', '{"name":"u"}\n');
    project.commit('seed');
    await project.xforge('init', '--flow', 'quick');
    mkdirSync(join(project.root, 'xforge', '.upgrade'), { recursive: true });
    writeFileSync(join(project.root, 'xforge', '.upgrade', 'status.yaml'), 'from: 1.0.1\nto: 9.9.9\n');

    const r = await repair(project, machine);
    expect(r.exit).toBe(1);
    expect(codes(r.env)).toEqual(['XF-ASSEMBLE-001']);
    const d = await project.xforge('doctor'); // 只读的照跑：哨兵拦的是写
    expect(codes(d.env)).not.toContain('XF-ASSEMBLE-001');
  });

  it('an unknown --platform is a usage error, not a silent skip', async () => {
    const r = await repair(p, machine, '--platform', 'cursor');
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('cursor');
  });

  it('the dictionary explains the codes only repair can raise', async () => {
    for (const [code, word] of [['XF-REPAIR-001', '载荷'], ['XF-REPAIR-002', '没落到盘上']]) {
      const r = await p.xforge('explain', code!);
      expect(r.exit, code).toBe(0);
      expect((r.env.result as { meaning: string }).meaning).toContain(word);
      expect(statSync(join(repoRoot, 'diagnostics', `${code}.yaml`)).isFile()).toBe(true);
    }
  });
});
