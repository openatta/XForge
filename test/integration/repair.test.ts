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

  it('--dry-run says what it would do and writes nothing', async () => {
    await breakFour();
    const r = await p.xforge('repair', '--dry-run');
    expect(r.exit).toBe(0);
    expect(r.env.changed).toEqual([]);
    expect(repaired(r).dry_run).toBe(true);
    expect(repaired(r).repaired).toEqual(['claude', 'codex']);
    expect(repaired(r).fixed).toEqual([]);
    expect(r.env.diagnostics.some((d) => d.message.startsWith('会修：'))).toBe(true);
    expect((await p.xforge('doctor')).exit).toBe(1); // 还坏着
  });

  it('--only narrows it to the providers that reported that code', async () => {
    await breakFour();
    const r = await p.xforge('repair', '--only', 'XF-ASSEMBLE-008');
    expect(repaired(r).repaired).toEqual(['claude']);
    expect(repaired(r).left.map((f) => f.code)).toContain('XF-ASSEMBLE-006'); // codex 的漂移还在
    expect(readFileSync(join(p.root, '.codex', 'skills', 'xforge', 'SKILL.md'), 'utf8')).toContain('人手加的一句');
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
