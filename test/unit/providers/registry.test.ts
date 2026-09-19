// design: cli §5 — provider 注册表：探测的注入形式、当前宿主的选法、钩子命令串的展开。
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { governancePaths } from '../../../src/model/paths.js';
import type { Manifest } from '../../../src/model/types.js';
import { canEnforce, currentProvider, detect, hookCommandFor, knownProviderIds, parseDetect, providerFor, providers } from '../../../src/providers/index.js';

const manifest = (platforms: string[]): Manifest => ({ platforms } as unknown as Manifest);

describe('provider registry', () => {
  it('knows claude and codex, and nothing else', () => {
    expect(knownProviderIds()).toEqual(['claude', 'codex']);
    expect(providerFor('claude')?.displayName).toBe('Claude Code');
    expect(providerFor('zed')).toBeUndefined();
    expect(providers().every((p) => p.id && p.binary)).toBe(true);
  });

  it('capabilities say what each host can do, and name the mechanism (D13)', () => {
    expect(providerFor('claude')!.capabilities).toEqual({ enforcement: 'hook', isolation: true });
    expect(providerFor('claude')!.hookFile).toBe('.claude/settings.json'); // 落点是声明，不是写死在判定里
    expect(providerFor('codex')!.capabilities).toEqual({ enforcement: 'hook', isolation: false });
    expect(providerFor('codex')!.hookFile).toBe('.codex/config.toml');
    // codex 的钩子装上之后还要人在它的 /hooks 里放行一次，而那一步我们看不见（D8）。
    expect(providerFor('codex')!.hookNeedsHostTrust).toBe(true);
    expect(providerFor('claude')!.hookNeedsHostTrust).toBeUndefined();
    expect(canEnforce(providerFor('claude')!)).toBe(true);
    expect(canEnforce(providerFor('codex')!)).toBe(true);
  });
});

describe('detection', () => {
  it('parses the injected form', () => {
    expect(parseDetect(undefined)).toBeNull();
    expect([...parseDetect('claude:2.1.0,codex:none')!]).toEqual([['claude', '2.1.0'], ['codex', 'none']]);
    expect([...parseDetect('claude')!]).toEqual([['claude', 'yes']]);
    expect([...parseDetect('')!]).toEqual([]);
  });

  it('injection wins over the PATH probe, in both directions', () => {
    const claude = providerFor('claude')!;
    expect(detect(claude, { XFORGE_DETECT: 'claude:2.1.0' })).toEqual({ installed: true, version: '2.1.0' });
    expect(detect(claude, { XFORGE_DETECT: 'codex:1.0' }).installed).toBe(false);
    expect(detect(claude, { XFORGE_DETECT: 'claude:none' }).installed).toBe(false);
  });

  it('falls back to the PATH probe and never spawns', () => {
    const claude = providerFor('claude')!;
    const found = detect(claude, { PATH: '' });
    expect(found.installed).toBe(false);
    expect(found.why).toContain('claude');
  });
});

describe('current host (D8)', () => {
  it('XFORGE_HOST wins, then the first host in the manifest that can enforce', () => {
    expect(currentProvider(manifest(['claude', 'codex']), { XFORGE_HOST: 'codex' })?.id).toBe('codex');
    // 两个都能执法时优先选验得出来的那个：否则整个项目白白报 unavailable。
    expect(currentProvider(manifest(['codex', 'claude']), {})?.id).toBe('claude');
    expect(currentProvider(manifest(['codex']), {})?.id).toBe('codex');
    expect(currentProvider(manifest(['zed']), {})).toBeUndefined();
    expect(currentProvider(manifest(['claude']), { XFORGE_HOST: 'zed' })).toBeUndefined();
  });
});

describe('hook command (rule-files §3.5)', () => {
  it('comes from the declaration with ${platform} expanded, per host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xforge-hook-'));
    const paths = governancePaths(root);
    await mkdir(join(paths.scaffold, 'hooks'), { recursive: true });
    await writeFile(paths.hook('enforce'), 'name: enforce\nevents: [pre-tool-use]\ncommand: "xforge-enforce --host ${platform}"\n');
    expect(await hookCommandFor(paths, providerFor('claude')!)).toBe('xforge-enforce --host claude');
    expect(await hookCommandFor(paths, providerFor('codex')!)).toBe('xforge-enforce --host codex');
  });

  it('is null when the declaration is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xforge-hook-'));
    expect(await hookCommandFor(governancePaths(root), providerFor('claude')!)).toBeNull();
  });
});

describe('注册表是名字的唯一来源（D14）', () => {
  it('id 合法且不重复 —— Platform 放宽成 string 之后，这条由运行时守', () => {
    const ids = providers().map((p) => p.id);
    expect(ids).toEqual([...new Set(ids)]);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    // help 里的 provider 列表也从这里来，加一个 provider 不用改帮助文本。
    expect(knownProviderIds()).toEqual(ids);
  });
});
