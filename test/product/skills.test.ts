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
