// design: cli §5 — codex provider：Skill 到 .codex/skills，AGENTS.md 标记块内一句入口说明，
// 执法钩子到 .codex/config.toml 的标记块内；无隔离。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from '../fs/transaction.js';
import { BLOCK_BEGIN, generatedNote, mergeMarkerBlock, scanHostDir, stripMarkerBlock, TOML_MARKERS, type HostFile } from './shared.js';
import type { Provider, ProjectionInput } from './index.js';

/** 执法钩子落在这里（项目根相对）：投影、检查、拆除都从这一处取。 */
const CONFIG = '.codex/config.toml';

/**
 * `AGENTS.md` 标记块里的入口说明。执法那句**由能力推出来**，不写死 ——
 * 否则能力哪天变了，这段话会继续说旧话。
 */
function agentsBlock(hasHook: boolean): string {
  return [
    '本项目由 XForge 治理。推进当前 Change 用 `xforge` Skill（.codex/skills/xforge/SKILL.md）；',
    '控制面的回答以 `xforge state` 为准，需要正文用 `xforge show <ref>`。',
    hasHook
      ? '这个宿主装了执法钩子（.codex/config.toml）：写入范围由权限策略拦。**钩子要你先在 `/hooks` 里过一遍才会跑**，改过之后要再过一遍；在那之前 `xforge state --orient` 会照实报 `enforcement: unavailable`。'
      : '这个宿主没有执法钩子：写入范围由人复核，`xforge state --orient` 会报 `enforcement: unavailable`。',
  ].join('\n');
}

/**
 * 钩子在 `.codex/config.toml` 里的样子。形状 2026-09-19 在 codex 0.155.1 上实测确认：
 * 事件键是 PascalCase（`[[hooks.PreToolUse]]`，不是 snake_case），`matcher` 要给 `"*"`（空串匹配不上），
 * 处理器是 `type = "command"`。
 */
function hookBlock(command: string): string {
  return ['[[hooks.PreToolUse]]', 'matcher = "*"', '', '[[hooks.PreToolUse.hooks]]', 'type = "command"', `command = ${JSON.stringify(command)}`].join('\n');
}

export const codexProvider: Provider = {
  id: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  capabilities: { enforcement: 'hook', isolation: false },
  hookFile: CONFIG,
  // 钩子装进去之后还要人在 `/hooks` 里过一遍才会跑，而那一步控制面看不见（D8）。
  hookNeedsHostTrust: true,

  async project(input: ProjectionInput): Promise<HostFile[]> {
    const out: HostFile[] = [];
    for (const s of input.skills) out.push({ path: join(input.root, '.codex', 'skills', s.name, 'SKILL.md'), content: generatedNote(s.text) });
    const agentsPath = join(input.root, 'AGENTS.md');
    out.push({ path: agentsPath, content: mergeMarkerBlock((await readText(agentsPath)) ?? '', agentsBlock(input.hookCommand !== null)), shared: true });
    if (input.hookCommand) {
      const path = join(input.root, CONFIG);
      out.push({ path, content: mergeMarkerBlock((await readText(path)) ?? '', hookBlock(input.hookCommand), TOML_MARKERS), shared: true, markers: { ...TOML_MARKERS } });
    }
    return out;
  },

  async hookInstalled(root: string, command: string | null): Promise<boolean> {
    if (!command) return false;
    const text = await readText(join(root, CONFIG));
    return text !== null && text.includes(`command = ${JSON.stringify(command)}`);
  },

  async footprint(root: string): Promise<Array<{ path: string; kind: 'owned' | 'shared' }>> {
    const out = scanHostDir(root, '.codex', null);
    for (const [rel, mark] of [['AGENTS.md', BLOCK_BEGIN], [CONFIG, TOML_MARKERS.begin]] as const) {
      const p = join(root, rel);
      if (existsSync(p) && readFileSync(p, 'utf8').includes(mark)) out.push({ path: p, kind: 'shared' });
    }
    return out;
  },

  async detach(root: string, path: string): Promise<HostFile | null> {
    for (const [rel, marks] of [['AGENTS.md', { begin: BLOCK_BEGIN, end: '<!-- XFORGE:END -->' }], [CONFIG, { ...TOML_MARKERS }]] as const) {
      if (path !== join(root, rel)) continue;
      const text = await readText(path);
      if (!text || !text.includes(marks.begin)) return null;
      return { path, content: stripMarkerBlock(text, marks), shared: true, markers: { ...marks } };
    }
    return null;
  },
};
