// design: cli §0 — D10：拆除需要点名确认；删治理目录与全部宿主投影，块外内容逐字节保留。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Project } from '../helpers/project.js';

describe('remove', () => {
  it('refuses without the exact confirmation, then removes everything it projected and nothing else', async () => {
    const p = await Project.create('remove');
    await p.write('package.json', '{"name":"r"}\n');
    await p.write('AGENTS.md', '# mine\n\nkeep\n');
    p.commit('seed');
    await p.xforge('init', '--flow', 'quick', '--platform', 'claude', '--platform', 'codex');
    expect(readFileSync(join(p.root, 'AGENTS.md'), 'utf8')).toContain('<!-- XFORGE:BEGIN -->');
    const none = await p.xforge('remove');
    expect(none.exit).toBe(1);
    expect(none.env.diagnostics[0]?.code).toBe('XF-ASSEMBLE-004');
    const wrong = await p.xforge('remove', '--confirm', 'something-else');
    expect(wrong.exit).toBe(1);
    expect(existsSync(join(p.root, 'xforge'))).toBe(true);
    const ok = await p.xforge('remove', '--confirm', basename(p.root));
    expect(ok.exit, JSON.stringify(ok.env)).toBe(0);
    expect(existsSync(join(p.root, 'xforge'))).toBe(false);
    expect(existsSync(join(p.root, '.claude', 'skills', 'xforge'))).toBe(false);
    expect(existsSync(join(p.root, '.claude', 'agents', 'xforge-executor.md'))).toBe(false);
    expect(existsSync(join(p.root, '.codex', 'skills', 'xforge-design'))).toBe(false);
    const settings = JSON.parse(readFileSync(join(p.root, '.claude', 'settings.json'), 'utf8')) as { hooks?: { PreToolUse?: unknown[] } };
    expect(settings.hooks?.PreToolUse ?? []).toEqual([]);
    expect(readFileSync(join(p.root, 'AGENTS.md'), 'utf8')).toBe('# mine\n\nkeep\n');
    expect(existsSync(join(p.root, 'package.json'))).toBe(true);
  });
});
