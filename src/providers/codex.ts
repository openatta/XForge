// design: cli §5 — codex provider：Skill 到 .codex/skills，AGENTS.md 标记块内一句入口说明；无钩子、无隔离。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from '../fs/transaction.js';
import { BLOCK_BEGIN, generatedNote, mergeMarkerBlock, scanHostDir, stripMarkerBlock, type HostFile } from './shared.js';
import type { Provider, ProjectionInput } from './index.js';

const AGENTS_BLOCK = ['本项目由 XForge 治理。推进当前 Change 用 `xforge` Skill（.codex/skills/xforge/SKILL.md）；', '控制面的回答以 `xforge state` 为准，需要正文用 `xforge show <ref>`。', '这个宿主没有执法钩子：写入范围由人复核，`xforge state --orient` 会报 `enforcement: unavailable`。'].join('\n');

export const codexProvider: Provider = {
  id: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  capabilities: { enforcement: 'none', isolation: false },

  async project(input: ProjectionInput): Promise<HostFile[]> {
    const out: HostFile[] = [];
    for (const s of input.skills) out.push({ path: join(input.root, '.codex', 'skills', s.name, 'SKILL.md'), content: generatedNote(s.text) });
    const agentsPath = join(input.root, 'AGENTS.md');
    out.push({ path: agentsPath, content: mergeMarkerBlock((await readText(agentsPath)) ?? '', AGENTS_BLOCK), shared: true });
    return out;
  },

  async hookInstalled(): Promise<boolean> {
    return false;
  },

  async footprint(root: string): Promise<Array<{ path: string; kind: 'owned' | 'shared' }>> {
    const out = scanHostDir(root, '.codex', null);
    const agents = join(root, 'AGENTS.md');
    if (existsSync(agents) && readFileSync(agents, 'utf8').includes(BLOCK_BEGIN)) out.push({ path: agents, kind: 'shared' });
    return out;
  },

  async detach(root: string, path: string): Promise<HostFile | null> {
    if (path !== join(root, 'AGENTS.md')) return null;
    const text = await readText(path);
    if (!text || !text.includes(BLOCK_BEGIN)) return null;
    return { path, content: stripMarkerBlock(text), shared: true };
  },
};
