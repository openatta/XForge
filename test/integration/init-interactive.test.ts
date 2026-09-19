// design: cli §5.1 — CLI-44 的端到端那一半：假 TTY 驱动真的 main()，画面在 stderr、信封在 stdout。
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { main } from '../../src/cli/index.js';
import { Project } from '../helpers/project.js';

const ESC = String.fromCharCode(27);

interface Session {
  exit: Promise<number>;
  seen: () => string;
  out: () => string;
  key: (k: string) => Promise<void>;
  /** 等画面上出现这句话；init 在问之前要先铺载荷，等不到就是没问。 */
  wait: (text: string) => Promise<void>;
}

/** stdin 与 stderr 装成 TTY（画面走 stderr），stdout 故意**不是** TTY —— `xforge init > out.json` 就是这个样子。 */
function start(argv: string[], cwd: string, env: Record<string, string>): Session {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
  stdin.isTTY = true;
  stdin.setRawMode = (): void => undefined;
  const stdout = new PassThrough();
  const stderr = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number };
  stderr.isTTY = true;
  stderr.columns = 200;
  let screen = '';
  let envelope = '';
  stderr.on('data', (d: Buffer) => (screen += d.toString()));
  stdout.on('data', (d: Buffer) => (envelope += d.toString()));
  const exit = main(argv, { cwd, env, stdin, stdout, stderr });
  const wait = async (text: string): Promise<void> => {
    const started = Date.now();
    while (!screen.includes(text)) {
      if (Date.now() - started > 5000) throw new Error(`没等到「${text}」；画面是：${screen}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return {
    exit,
    seen: () => screen,
    out: () => envelope,
    wait,
    key: async (k: string) => {
      stdin.write(k);
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}

describe('interactive init (CLI-44)', () => {
  it('asks for tools and language, greys out what is missing, and keeps stdout to the envelope', async () => {
    const p = await Project.create('interactive');
    const s = start(['init', '--flow', 'quick'].slice(0, 1), p.root, { XFORGE_DETECT: 'claude:2.1.0,codex:none', XFORGE_NOW: '2026-09-15T10:00:00.000Z' });
    await s.wait('Which AI coding tools should XForge project into?');
    expect(s.seen()).toContain('Claude Code');
    expect(s.seen()).toContain('detected 2.1.0');
    expect(s.seen()).toContain('not detected');

    await s.key('\r'); // 什么都没选：不放行
    await s.wait('Select at least one with space.');
    await s.key(`${ESC}[B`); // 光标跳过灰显的 codex，绕回 claude
    await s.key(' ');
    await s.key('\r');
    await s.wait('Which language should the projected Skills use?');
    await s.key(`${ESC}[B`); // English
    await s.key(' ');
    await s.key('\r');

    expect(await s.exit).toBe(0);
    const manifest = parse(readFileSync(join(p.root, 'xforge', 'manifest.yaml'), 'utf8')) as { platforms: string[]; language: string };
    expect(manifest.platforms).toEqual(['claude']);
    expect(manifest.language).toBe('en');
    expect(readFileSync(join(p.root, '.claude', 'skills', 'xforge', 'SKILL.md'), 'utf8')).toContain('You are the orchestrator');

    // stdout 只有信封：一行 JSON，能解析，没有一个转义序列。
    const lines = s.out().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { ok: boolean; verb: string }).verb).toBe('init');
    expect(s.out()).not.toContain(ESC);
    expect(s.seen()).toContain(ESC); // 画面才有颜色与光标控制
  });

  it('只问命令行没说的那一半：给了 --platform 就只问语言', async () => {
    const p = await Project.create('interactive-half');
    const s = start(['init', '--platform', 'codex'], p.root, { XFORGE_DETECT: 'claude:none,codex:none', XFORGE_NOW: '2026-09-15T10:00:00.000Z' });
    await s.wait('Which language should the projected Skills use?');
    expect(s.seen()).not.toContain('Which AI coding tools'); // 说过的话不再问一遍
    await s.key('\r');
    expect(await s.exit).toBe(0);
    const manifest = parse(readFileSync(join(p.root, 'xforge', 'manifest.yaml'), 'utf8')) as { platforms: string[]; language: string };
    expect(manifest.platforms).toEqual(['codex']); // 没探测到也照投：命令行点名就是那条出路
    expect(manifest.language).toBe('zh-CN');
  });

  it('两个答案都给了就一个字都不问；--no-input 与 CI 各是一条明确的「别问」', async () => {
    const both = await Project.create('interactive-none');
    const a = start(['init', '--platform', 'codex', '--language', 'en'], both.root, { XFORGE_DETECT: 'claude:none', XFORGE_NOW: '2026-09-15T10:00:00.000Z' });
    expect(await a.exit).toBe(0);
    expect(a.seen()).toBe('');

    const quiet = await Project.create('interactive-noinput');
    const b = start(['init', '--no-input'], quiet.root, { XFORGE_DETECT: 'claude:2.1.0', XFORGE_NOW: '2026-09-15T10:00:00.000Z' });
    expect(await b.exit).toBe(0);
    expect(b.seen()).toBe('');

    const ci = await Project.create('interactive-ci');
    const c = start(['init'], ci.root, { CI: '1', XFORGE_DETECT: 'claude:2.1.0', XFORGE_NOW: '2026-09-15T10:00:00.000Z' });
    expect(await c.exit).toBe(0);
    expect(c.seen()).toBe('');
    const manifest = parse(readFileSync(join(ci.root, 'xforge', 'manifest.yaml'), 'utf8')) as { platforms: string[]; language: string };
    expect(manifest).toMatchObject({ platforms: ['claude'], language: 'zh-CN' });
  });

  it('取消是人的决定：给信封、退出码 1、树上一个字节不动', async () => {
    const p = await Project.create('interactive-esc');
    const s = start(['init'], p.root, { XFORGE_DETECT: 'claude:2.1.0', XFORGE_NOW: '2026-09-15T10:00:00.000Z' });
    await s.wait('Which AI coding tools should XForge project into?');
    await s.key(ESC);
    expect(await s.exit).toBe(1); // 不是 2 —— 命令行没写错
    const env = JSON.parse(s.out().trim()) as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(env.ok).toBe(false);
    expect(env.diagnostics[0]?.code).toBe('XF-ASSEMBLE-018');
    expect(() => readFileSync(join(p.root, 'xforge', 'manifest.yaml'), 'utf8')).toThrow();
  });
});
