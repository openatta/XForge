// design: skills §1 §2 §4 — SK-01…SK-05、SK-08、SK-09：能静态检查的 Skill 断言。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headings, localZone } from '../../src/model/markdown.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillsDir = join(root, 'scaffold', 'skills');
const STATIONS = ['propose', 'clarify', 'design', 'check', 'apply', 'verify'];
const read = (...p: string[]): string => readFileSync(join(skillsDir, ...p), 'utf8');
const body = (text: string): string => text.replace(/^---[\s\S]*?\n---\n/, '');

describe('entry skill', () => {
  for (const file of ['SKILL_cn.md', 'SKILL.md']) {
    const text = body(read('xforge', file));
    it(`SK-01 ${file} carries no station→skill routing table`, () => {
      for (const s of STATIONS) expect(text.includes(`xforge-${s}`), `mentions xforge-${s}`).toBe(false);
    });
    it(`SK-02 ${file} never tells the entry to open upstream files`, () => {
      expect(/\b(Read|cat|open|sed -n|head)\b[^\n]*\b(proposal|design|assurance)\.md/.test(text)).toBe(false);
    });
    it(`SK-12 ${file} takes advance's stage as the next orientation and stops at ready-to-archive without another state`, () => {
      expect(text.includes('`stage`')).toBe(true);
      expect(text.includes('ready-to-archive')).toBe(true);
      expect(text.includes('`advance`') || text.includes('`xforge advance`')).toBe(true);
    });
  }
});

describe('station skills', () => {
  const dirs = readdirSync(skillsDir).filter((d) => d.startsWith('xforge-')).sort();
  it('there is exactly one station skill per station', () => {
    expect(dirs).toEqual(STATIONS.map((s) => `xforge-${s}`).sort());
  });
  for (const dir of dirs) {
    for (const file of ['SKILL_cn.md', 'SKILL.md']) {
      const text = read(dir, file);
      const content = body(text);
      it(`SK-13 ${dir}/${file} tells a stage-by-stage user the next Skill from advance's stage.skill`, () => {
        const first = body(text).split('\n').find((l) => l.trim() && !l.startsWith('#'))!;
        expect(first).toContain('`stage.skill`');
        expect(first).toContain('`/<skill>`');
        expect(first).toContain('`advance`');
      });
      it(`SK-03 ${dir}/${file} has the four sections in order with a local zone in the last`, () => {
        expect(headings(content, 2)).toEqual(['判断', '边界', '停下', '本项目']);
        const zone = localZone(content);
        expect(zone).not.toBeNull();
        expect(zone!.before.lastIndexOf('## 本项目')).toBeGreaterThan(zone!.before.lastIndexOf('## 停下'));
      });
      it(`SK-04 ${dir}/${file} carries no incident memory (no diagnostic codes)`, () => {
        expect(/XF-[A-Z]+-\d{3}/.test(content)).toBe(false);
      });
      it(`SK-05 ${dir}/${file} does not branch on flow names`, () => {
        expect(/\b(quick|solid|major)\b/.test(content), 'mentions a flow name').toBe(false);
      });
    }
  }
});

describe('executor prompt', () => {
  for (const file of ['executor-prompt_cn.md', 'executor-prompt.md']) {
    const text = read('xforge', file);
    it(`SK-08 ${file} names the three report forms`, () => {
      for (const form of ['XFORGE-REPORT: done', 'XFORGE-REPORT: blocked', 'XFORGE-REPORT: needs-human']) expect(text).toContain(form);
    });
    it(`SK-09 ${file} carries no path literals, station names or flag explanations`, () => {
      expect(/xforge\/[a-z]/.test(text), 'governance path literal').toBe(false);
      for (const s of STATIONS) expect(new RegExp(`\\b${s}\\b`).test(text), `station ${s}`).toBe(false);
      const commands = [...text.matchAll(/`xforge ([a-z]+)[^`]*`/g)].map((m) => m[1]);
      expect(new Set(commands)).toEqual(new Set(['state', 'show', 'advance']));
      expect(/--[a-z]/.test(text), 'flag explanation').toBe(false);
    });
  }
});

describe('停下条件与控制面的词汇要对得上（SK-14）', () => {
  /** 控制面真会产出的 blocker token。带后缀的（`unclaimed:<路径>`）在这里记前缀。 */
  const produced = (): Set<string> => {
    const src = readFileSync(join(root, 'src', 'verbs', 'exit.ts'), 'utf8') + readFileSync(join(root, 'src', 'verbs', 'state.ts'), 'utf8');
    const out = new Set<string>();
    for (const m of src.matchAll(/token: '([a-z-]+)'/g)) out.add(m[1]!);
    for (const m of src.matchAll(/token: `([a-z-]+):\$\{/g)) out.add(m[1]!);
    for (const m of src.matchAll(/token: status === 'stale' \? '([a-z-]+)' : '([a-z-]+)'/g)) {
      out.add(m[1]!);
      out.add(m[2]!);
    }
    return out;
  };

  it('站 Skill 里每个 blocked <token> 都是控制面产得出来的', () => {
    const known = produced();
    expect(known.size, '没从 exit.ts / state.ts 里解析出 token，正则该跟着改').toBeGreaterThan(8);
    const offenders: string[] = [];
    for (const station of STATIONS) {
      for (const file of [`SKILL_cn.md`, `SKILL.md`]) {
        const text = read(`xforge-${station}`, file);
        for (const m of text.matchAll(/`blocked ([a-z-]+)(?::[^`]*)?`/g)) {
          const token = m[1]!;
          if (!known.has(token)) offenders.push(`xforge-${station}/${file}: blocked ${token}`);
        }
      }
    }
    // 控制面判不出来的理由要走 needs-human：拿一个查不到的 token 去问 blockers，
    // 入口什么也说不出来，用户看到的是「被挡住了，但控制面说没东西挡着」。
    expect(offenders, `这些 token 控制面从不产出：\n${offenders.join('\n')}\n认得的是：${[...known].sort().join('、')}`).toEqual([]);
  });

  it('入口 Skill 写明查不到 remedy 时要原样转述，不许哑掉', () => {
    for (const file of ['SKILL_cn.md', 'SKILL.md']) {
      const text = read('xforge', file);
      expect(/没有这个 token|no such token/.test(text), file).toBe(true);
    }
  });
});
