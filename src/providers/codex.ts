// design: cli §5 — codex provider：Skill 到 .codex/skills，AGENTS.md 标记块内一句入口说明；无钩子、无隔离。
import { join } from 'node:path';
import { readText } from '../fs/transaction.js';
import { generatedNote, mergeMarkerBlock, type HostFile } from './shared.js';
import type { Provider, ProjectionInput } from './index.js';

const AGENTS_BLOCK = ['本项目由 XForge 治理。推进当前 Change 用 `xforge` Skill（.codex/skills/xforge/SKILL.md）；', '控制面的回答以 `xforge state` 为准，需要正文用 `xforge show <ref>`。', '这个宿主没有执法钩子：写入范围由人复核，`xforge state --orient` 会报 `enforcement: unavailable`。'].join('\n');

export const codexProvider: Provider = {
  id: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  capabilities: { enforcement: false, isolation: false },

  async project(input: ProjectionInput): Promise<HostFile[]> {
    const out: HostFile[] = [];
    for (const s of input.skills) out.push({ path: join(input.root, '.codex', 'skills', s.name, 'SKILL.md'), content: generatedNote(s.text) });
    const agentsPath = join(input.root, 'AGENTS.md');
    out.push({ path: agentsPath, content: mergeMarkerBlock((await readText(agentsPath)) ?? '', AGENTS_BLOCK) });
    return out;
  },

  async hookInstalled(): Promise<boolean> {
    return false;
  },
};
