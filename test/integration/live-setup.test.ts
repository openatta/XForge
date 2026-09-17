// design: live-test §1 — LT-01：种子项目自身全绿，铺好治理后 inspect --all --hygiene 干净；不经模型。
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupProject } from '../live/harness/setup.js';
import { repoRoot, xforge } from '../live/harness/xforge.js';

describe('live harness setup', () => {
  it('LT-01 seeds invoicely with both baselines governed and a clean inspect', async () => {
    const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'xforge-live-setup-')));
    const paths = { runDir, workDir: runDir, project: join(runDir, 'project'), claudeConfig: join(runDir, 'claude-config'), transcripts: join(runDir, 'transcripts'), shim: join(runDir, 'bin') };
    const scenarioDir = join(repoRoot, 'test', 'live', 'scenarios', 'invoicely');
    await setupProject(paths, { repoRoot, scenarioDir, flow: 'solid', language: 'zh-CN', request: '# 需求\n', engine: 'gateway', cli: 'repo' });

    const tests = execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: paths.project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(tests).toBe('');
    expect(existsSync(join(paths.project, '.claude', 'skills', 'xforge', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(paths.project, '.claude', 'agents', 'xforge-executor.md'))).toBe(true);
    const manifest = readFileSync(join(paths.project, 'xforge', 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('spec: true');
    expect(manifest).toContain('unit-tests: python3 -m unittest discover -s tests');

    const inspect = await xforge(paths.project, ['inspect', '--all', '--hygiene']);
    expect(inspect.exit, JSON.stringify(inspect.env)).toBe(0);
    expect(inspect.env.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);

    const state = await xforge(paths.project, ['state', '--orient']);
    const orient = (state.env.result as { orient: { invariants: { governance: { spec: boolean; interface: boolean }; spec_domains: Array<{ id: string }>; constitution: string[] } } }).orient;
    expect(orient.invariants.governance).toEqual({ spec: true, interface: true, assurance: true });
    expect(orient.invariants.spec_domains.map((d) => d.id)).toEqual(['billing']);
    expect(orient.invariants.constitution).toEqual(['不做无测试的行为变更', '只用标准库']);
  });
});
