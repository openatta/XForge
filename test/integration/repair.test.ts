// design: cli §5.5 — CLI-43：四种问题一次修完、幂等、--dry-run 不写盘、标记块坏了的 provider 整个不碰。
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Project, type Result } from '../helpers/project.js';

const codes = (r: Result): string[] => r.env.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.code).sort();
const repaired = (r: Result): { repaired: string[]; fixed: Array<{ code: string }>; left: Array<{ code: string }>; dry_run: boolean } =>
  r.env.result as { repaired: string[]; fixed: Array<{ code: string }>; left: Array<{ code: string }>; dry_run: boolean };

describe('repair (CLI-43)', () => {
  let p: Project;
  const skillDir = (name: string): string => join(p.root, 'xforge', 'scaffold', 'skills', name);

  beforeEach(async () => {
    p = await Project.create('repair');
    await p.write('AGENTS.md', '# mine\n\nkeep\n');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude', '--platform', 'codex');
  });

  /** 四种能自动修的问题各一处：缺失、漂移、孤儿、钩子不在。 */
  const breakFour = async (): Promise<void> => {
    mkdirSync(skillDir('xforge-extra'), { recursive: true });
    writeFileSync(join(skillDir('xforge-extra'), 'SKILL_cn.md'), '---\nname: xforge-extra\ndescription: x\n---\n\n# x\n');
    await p.xforge('sync');
    rmSync(skillDir('xforge-extra'), { recursive: true, force: true }); // 孤儿
    rmSync(join(p.root, '.claude', 'skills', 'xforge-design', 'SKILL.md')); // 缺失
    const drifted = join(p.root, '.codex', 'skills', 'xforge', 'SKILL.md');
    writeFileSync(drifted, readFileSync(drifted, 'utf8') + '\n人手加的一句\n'); // 漂移
    writeFileSync(join(p.root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n'); // 钩子不在
  };

  it('fixes all four in one pass, then has nothing left to do', async () => {
    await breakFour();
    // 那个多出来的 Skill 两个宿主各投了一份，所以孤儿有两条。
    expect(codes(await p.xforge('doctor'))).toEqual(['XF-ASSEMBLE-006', 'XF-ASSEMBLE-006', 'XF-ASSEMBLE-007', 'XF-ASSEMBLE-007', 'XF-ASSEMBLE-008']);
    const r = await p.xforge('repair');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(repaired(r).repaired).toEqual(['claude', 'codex']);
    expect(repaired(r).fixed.map((f) => f.code).sort()).toEqual(['XF-ASSEMBLE-006', 'XF-ASSEMBLE-006', 'XF-ASSEMBLE-007', 'XF-ASSEMBLE-007', 'XF-ASSEMBLE-008']);
    expect(repaired(r).left).toEqual([]);
    const after = await p.xforge('doctor');
    expect(after.exit).toBe(0);
    expect((after.env.result as { problems: number }).problems).toBe(0);
    expect(existsSync(join(p.root, '.claude', 'skills', 'xforge-extra'))).toBe(false);
    // 幂等
    const again = await p.xforge('repair');
    expect(again.env.changed).toEqual([]);
    expect(repaired(again).repaired).toEqual([]);
  });

  it('--dry-run says what it would do, writes nothing, and keeps the tree\'s own verdict (CLI-43)', async () => {
    await breakFour();
    const r = await p.xforge('repair', '--dry-run');
    // 预演不是通过：树上还坏着，退出码就得跟 doctor 一样，否则 CI 把坏树当好的。
    expect(r.exit).toBe(1);
    expect(r.exit).toBe((await p.xforge('doctor')).exit);
    expect(r.env.changed).toEqual([]);
    expect(repaired(r).dry_run).toBe(true);
    expect(repaired(r).repaired).toEqual(['claude', 'codex']);
    expect(repaired(r).fixed).toEqual([]);
    expect(r.env.diagnostics.some((d) => d.message.startsWith('会修：'))).toBe(true);
    expect((await p.xforge('doctor')).exit).toBe(1); // 还坏着
  });


  it('a provider whose marker block a person broke is left alone, byte for byte', async () => {
    const agents = join(p.root, 'AGENTS.md');
    writeFileSync(agents, '# mine\n<!-- XFORGE:BEGIN -->\nhalf\n');
    rmSync(join(p.root, '.codex', 'skills', 'xforge-design', 'SKILL.md')); // 同一个 provider 上还有一处能修的
    rmSync(join(p.root, '.claude', 'skills', 'xforge-design', 'SKILL.md'));
    const before = readFileSync(agents, 'utf8');
    const r = await p.xforge('repair');
    expect(repaired(r).repaired).toEqual(['claude']); // codex 整个不碰
    expect(readFileSync(agents, 'utf8')).toBe(before);
    expect(repaired(r).left.map((f) => f.code)).toContain('XF-ASSEMBLE-010');
    expect(existsSync(join(p.root, '.codex', 'skills', 'xforge-design', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(p.root, '.claude', 'skills', 'xforge-design', 'SKILL.md'))).toBe(true);
  });
});

describe('the scaffold checks itself against its own integrity manifest (CLI-49)', () => {
  let p: Project;
  const scaffold = (rel: string): string => join(p.root, 'xforge', 'scaffold', rel);
  const codesOf = async (): Promise<string[]> => (await p.xforge('doctor')).env.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.code);

  beforeEach(async () => {
    p = await Project.create('scaffoldcheck');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude');
  });

  it('删掉一个受管文件：报 015，repair 从载荷补回来', async () => {
    const gate = scaffold('gates/ledgers.yaml');
    const before = readFileSync(gate, 'utf8');
    rmSync(gate);
    expect(await codesOf()).toContain('XF-ASSEMBLE-015');

    const r = await p.xforge('repair');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect((r.env.result as { restored: string[] }).restored).toContain('gates/ledgers.yaml');
    expect(readFileSync(gate, 'utf8')).toBe(before);
    expect(await codesOf()).not.toContain('XF-ASSEMBLE-015');
  });

  it('本地化区之外被改过的正文：报 015，但 repair 一个字节都不动', async () => {
    const gate = scaffold('gates/ledgers.yaml');
    writeFileSync(gate, readFileSync(gate, 'utf8') + '\n# 人写的一行\n');
    const mine = readFileSync(gate, 'utf8');
    expect(await codesOf()).toContain('XF-ASSEMBLE-015');

    const r = await p.xforge('repair');
    expect(readFileSync(gate, 'utf8')).toBe(mine); // 覆盖它得先问人 —— 那是 update 的活
    expect(r.env.diagnostics.some((d) => d.code === 'XF-ASSEMBLE-015')).toBe(true);
    expect(r.exit).toBe(1);
  });

  it('清单语言对应的 Skill 源没了：sync 会静默少投影一个，所以 doctor 必须说出来', async () => {
    rmSync(scaffold('skills/xforge-design/SKILL_cn.md'));
    const d = await p.xforge('doctor');
    const found = d.env.diagnostics.find((x) => x.code === 'XF-ASSEMBLE-015' && x.message.includes('xforge-design'));
    expect(found?.severity).toBe('blocking');
    expect(found?.message).toContain('SKILL_cn.md');

    const r = await p.xforge('repair');
    expect(r.exit, JSON.stringify(r.env)).toBe(0);
    expect(existsSync(scaffold('skills/xforge-design/SKILL_cn.md'))).toBe(true);
    // 补回来的那一份在同一轮里就投出去了，不用再跑一次 sync。
    expect(existsSync(join(p.root, '.claude', 'skills', 'xforge-design', 'SKILL.md'))).toBe(true);
    expect((await p.xforge('sync')).env.changed).toEqual([]);
  });

  it('--dry-run 只说打算补什么，不写盘', async () => {
    rmSync(scaffold('gates/ledgers.yaml'));
    const r = await p.xforge('repair', '--dry-run');
    expect(r.env.changed).toEqual([]);
    expect((r.env.result as { restored: string[]; dry_run: boolean }).dry_run).toBe(true);
    expect((r.env.result as { restored: string[] }).restored).toContain('gates/ledgers.yaml');
    expect(existsSync(scaffold('gates/ledgers.yaml'))).toBe(false);
  });
});

describe('缺的与多的不打架（CLI-52）', () => {
  let p: Project;
  const codesOf = async (): Promise<string[]> => (await p.xforge('doctor')).env.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.code);

  beforeEach(async () => {
    p = await Project.create('conflict');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude');
  });

  it('从脚手架删一个 Skill：只报 015，不报 007', async () => {
    rmSync(join(p.root, 'xforge', 'scaffold', 'skills', 'xforge-design'), { recursive: true });
    const codes = await codesOf();
    // 一边说「宿主上不该有它」一边说「脚手架里该有它」是自相矛盾：这时只有后一句成立。
    expect(codes).toContain('XF-ASSEMBLE-015');
    expect(codes).not.toContain('XF-ASSEMBLE-007');
    expect((await p.xforge('repair')).exit).toBe(0);
    expect(await codesOf()).toEqual([]);
  });

  it('清单里去掉一个 provider 才是真孤儿：那时报 007', async () => {
    await p.xforge('sync', '--platform', 'claude');
    const manifest = join(p.root, 'xforge', 'manifest.yaml');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('platforms:\n  - claude\n', 'platforms:\n  - codex\n'));
    const codes = await codesOf();
    expect(codes).toContain('XF-ASSEMBLE-007');
    expect(codes).not.toContain('XF-ASSEMBLE-015');
  });
});
