// design: skills §5 — claude 宿主：Skill 到 .claude/skills，执行者到 .claude/agents，执法钩子到 .claude/settings.json。
import { join } from 'node:path';
import { readText } from '../fs/transaction.js';
import type { Executor, Language } from '../model/types.js';
import { generatedNote, type HostFile, type SkillSource } from './shared.js';

export const ENFORCE_COMMAND = 'xforge-enforce --host claude';

export async function claudeFiles(projectRoot: string, skills: readonly SkillSource[], executor: { def: Executor; prompt: string } | null, _language: Language): Promise<HostFile[]> {
  const out: HostFile[] = [];
  for (const s of skills) out.push({ path: join(projectRoot, '.claude', 'skills', s.name, 'SKILL.md'), content: generatedNote(s.text) });
  if (executor) {
    const tools = executor.def.tools.map((t) => ({ read: 'Read, Glob, Grep', write: 'Write', edit: 'Edit, MultiEdit', shell: 'Bash' })[t]).join(', ');
    const body = ['---', `name: ${executor.def.name}`, `description: ${executor.def.description}`, `tools: ${tools}`, '---', '', executor.prompt.trim(), ''].join('\n');
    out.push({ path: join(projectRoot, '.claude', 'agents', `${executor.def.name}.md`), content: generatedNote(body) });
  }
  out.push({ path: join(projectRoot, '.claude', 'settings.json'), content: await settingsWithHook(join(projectRoot, '.claude', 'settings.json')) });
  return out;
}

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

/** 在现有 settings.json 里加（或保留）执法钩子；标记块之外的内容逐字节保留（JSON 无注释，靠命令串识别）。 */
async function settingsWithHook(path: string): Promise<string> {
  const text = await readText(path);
  let settings: Record<string, unknown> = {};
  if (text) {
    try {
      settings = JSON.parse(text) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  const hooks = (settings['hooks'] as Record<string, HookEntry[]> | undefined) ?? {};
  const pre = hooks['PreToolUse'] ?? [];
  const present = pre.some((e) => e.hooks?.some((h) => h.command === ENFORCE_COMMAND));
  if (!present) pre.push({ matcher: '', hooks: [{ type: 'command', command: ENFORCE_COMMAND, timeout: 10 }] });
  hooks['PreToolUse'] = pre;
  settings['hooks'] = hooks;
  return JSON.stringify(settings, null, 2) + '\n';
}
