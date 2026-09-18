// design: cli §5.3 — CLI-24：本地化区移植、改过正文的留在 incoming、哨兵拒绝其它命令、完成与回滚。
import { beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Project, repoRoot } from '../helpers/project.js';

const LOCAL = '<!-- xforge:local:begin -->\n我们的设计文档必须提到容量影响。\n<!-- xforge:local:end -->';

describe('update', () => {
  let p: Project;
  let payload: string;
  const skill = (name: string): string => join(p.root, 'xforge', 'scaffold', 'skills', name, 'SKILL_cn.md');

  beforeAll(async () => {
    p = await Project.create('update');
    await p.write('package.json', '{"name":"u"}\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'quick');
    // 项目：design 站 Skill 填了本地化区；check 站 Skill 改了正文；再假装清单还是旧版本。
    writeFileSync(skill('xforge-design'), readFileSync(skill('xforge-design'), 'utf8').replace('<!-- xforge:local:begin -->\n<!-- xforge:local:end -->', LOCAL));
    writeFileSync(skill('xforge-check'), readFileSync(skill('xforge-check'), 'utf8').replace('## 判断', '## 判断\n- 项目自己加的一条（改在区域之外）'));
    const manifestPath = join(p.root, 'xforge', 'manifest.yaml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(/scaffold:\n  version: .*\n/, 'scaffold:\n  version: 0.0.1\n'));
    // 新版载荷：design 与 check 的正文都改了，多了一道门。
    payload = await mkdtemp(join(tmpdir(), 'xforge-payload-'));
    cpSync(join(repoRoot, 'scaffold'), payload, { recursive: true });
    for (const name of ['xforge-design', 'xforge-check']) {
      const f = join(payload, 'skills', name, 'SKILL_cn.md');
      writeFileSync(f, readFileSync(f, 'utf8').replace('## 停下', '## 停下\n- 新版加的一条'));
    }
    mkdirSync(join(payload, 'gates'), { recursive: true });
    writeFileSync(join(payload, 'gates', 'lint.yaml'), 'name: lint\nkind: command\ncommand: {from: manifest}\ninputs: ["**/*"]\n');
  });

  it('stages: unchanged files replaced, local zone transplanted, edited body left for the person, new file added but not selected', async () => {
    const r = await p.xforge('update', '--payload', payload, '--to', '9.9.9');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    const res = r.env.result as { transplanted: string[]; pending: string[]; added: string[]; classified: Record<string, string> };
    expect(res.transplanted).toContain('skills/xforge-design/SKILL_cn.md');
    expect(res.pending).toEqual(['skills/xforge-check/SKILL_cn.md']);
    expect(res.added).toContain('gates/lint.yaml');
    const design = readFileSync(skill('xforge-design'), 'utf8');
    expect(design).toContain('- 新版加的一条'); // 新正文
    expect(design).toContain('我们的设计文档必须提到容量影响'); // 旧本地化区
    const check = readFileSync(skill('xforge-check'), 'utf8');
    expect(check).toContain('项目自己加的一条'); // 没被覆盖
    expect(check).not.toContain('- 新版加的一条');
    expect(existsSync(join(p.root, 'xforge', '.upgrade', 'incoming', 'skills', 'xforge-check', 'SKILL_cn.md'))).toBe(true);
    const manifest = parse(readFileSync(join(p.root, 'xforge', 'manifest.yaml'), 'utf8')) as { selected: { gates: string[] } };
    expect(manifest.selected.gates).not.toContain('lint');
  });

  it('the sentinel refuses everything but update and the read verbs while in flight', async () => {
    const blocked = await p.xforge('sync');
    expect(blocked.exit).toBe(1);
    expect(blocked.env.diagnostics[0]?.code).toBe('XF-ASSEMBLE-001');
    expect((await p.xforge('state')).exit).toBe(0);
    const status = await p.xforge('update', '--status');
    expect((status.env.result as { pending: string[] }).pending).toEqual(['skills/xforge-check/SKILL_cn.md']);
  });

  it('rollback restores the snapshot byte for byte and clears the sentinel', async () => {
    const before = readFileSync(skill('xforge-design'), 'utf8');
    const r = await p.xforge('update', '--rollback');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(readFileSync(skill('xforge-design'), 'utf8')).not.toBe(before);
    expect(readFileSync(skill('xforge-design'), 'utf8')).toContain('我们的设计文档必须提到容量影响');
    expect(existsSync(join(p.root, 'xforge', 'scaffold', 'gates', 'lint.yaml'))).toBe(false);
    expect(existsSync(join(p.root, 'xforge', '.upgrade'))).toBe(false);
    expect((await p.xforge('sync')).exit).toBe(0);
  });

  it('finish advances the version anchor, rewrites integrity, records what was kept, and clears the sentinel', async () => {
    expect((await p.xforge('update', '--payload', payload, '--to', '9.9.9')).exit).toBe(0);
    const r = await p.xforge('update', '--finish');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect((r.env.result as { kept: string[] }).kept).toEqual(['skills/xforge-check/SKILL_cn.md']);
    const manifest = parse(readFileSync(join(p.root, 'xforge', 'manifest.yaml'), 'utf8')) as { scaffold: { version: string } };
    expect(manifest.scaffold.version).toBe('9.9.9');
    const integrity = parse(readFileSync(join(p.root, 'xforge', 'scaffold', 'integrity.yaml'), 'utf8')) as { scaffold_version: string; files: Record<string, string> };
    expect(integrity.scaffold_version).toBe('9.9.9');
    expect(integrity.files['gates/lint.yaml']).toBeDefined();
    expect(readFileSync(join(p.root, 'xforge', '.audit', 'chain.jsonl'), 'utf8')).toContain('scaffold.upgraded');
    expect(existsSync(join(p.root, 'xforge', '.upgrade'))).toBe(false);
    expect((await p.xforge('update', '--finish')).env.diagnostics[0]?.code).toBe('XF-ASSEMBLE-003');
    expect((await p.xforge('update', '--payload', payload, '--to', '9.9.9')).env.diagnostics[0]?.code).toBe('XF-ASSEMBLE-002');
    expect((await p.xforge('inspect', '--all', '--hygiene')).exit).toBe(0);
  });

  // 1.0.1 已发出去了，`upgrade` 这个名字收不回来：照跑，但每次都说一声，且不挤掉真正的诊断。
  it('the old name upgrade still runs and appends a deprecation after the real diagnostics', async () => {
    const staged = await p.xforge('upgrade', '--payload', payload, '--to', '9.9.10');
    expect(staged.exit, JSON.stringify(staged.env)).toBe(0);
    expect(staged.env.diagnostics?.map((d) => d.code)).toEqual(['XF-ASSEMBLE-005']);
    const inFlight = await p.xforge('upgrade', '--status');
    expect((inFlight.env.result as { to: string }).to).toBe('9.9.10');
    expect(inFlight.env.diagnostics?.map((d) => d.code)).toEqual(['XF-ASSEMBLE-005']);
    // 抛错那条路走不到注入点：错误本身比「你用了旧名字」要紧。
    const missing = await p.xforge('upgrade');
    expect(missing.exit).toBe(1);
    expect(missing.env.diagnostics?.map((d) => d.code)).toEqual(['XF-ASSEMBLE-001']);
    expect((await p.xforge('update', '--rollback')).exit).toBe(0);
  });
});
