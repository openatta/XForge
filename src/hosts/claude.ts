// design: skills §5 — claude 宿主：Skill 到 .claude/skills，执行者到 .claude/agents，执法钩子到 .claude/settings.json。
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readText } from '../fs/transaction.js';
import type { Hook, Platform, ToolAction } from '../model/types.js';
import { enforceCommand, generatedNote, HOOK_EVENTS, parseHostJson, SKILL_PREFIX, type HostFile, type HookEntry, type HostProvider } from './shared.js';

const ID: Platform = 'claude';

/** 执行者定义在宿主里的文件名（scaffold 里叫 `xforge-executor`，与 `scaffold/agents/` 同名）。 */
export const EXECUTOR_NAME = 'xforge-executor';

const SETTINGS = '.claude/settings.json';
const SKILLS_DIR = '.claude/skills';
const AGENTS_DIR = '.claude/agents';

/** 宿主中立的动作类 → claude 的工具名，投影执行者定义时用。 */
const TOOL_NAMES: Record<ToolAction, string> = { read: 'Read, Glob, Grep', write: 'Write', edit: 'Edit, MultiEdit', shell: 'Bash' };

export const claudeProvider: HostProvider = {
  id: ID,
  label: 'Claude Code',
  note: 'Skills, an isolated executor subagent, and the enforcement hook.',
  capabilities: { enforcement: 'hook', isolation: true },
  hookFile: SETTINGS,
  detection: { binaries: ['claude'], sessionEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'], homeConfigDir: '.claude' },

  async files(ctx): Promise<HostFile[]> {
    const out: HostFile[] = [];
    for (const s of ctx.skills) out.push({ path: join(ctx.root, SKILLS_DIR, s.name, 'SKILL.md'), content: generatedNote(s.text) });
    if (ctx.executor) out.push({ path: join(ctx.root, AGENTS_DIR, `${ctx.executor.def.name}.md`), content: generatedNote(executorFile(ctx.executor, ctx.hook)) });
    out.push({ path: join(ctx.root, SETTINGS), content: await settingsWithHook(join(ctx.root, SETTINGS), ctx.hook) });
    return out;
  },

  async ownership(root): Promise<string[]> {
    const out: string[] = [];
    const skills = join(root, SKILLS_DIR);
    if (existsSync(skills)) for (const d of readdirSync(skills)) if (d === SKILL_PREFIX || d.startsWith(`${SKILL_PREFIX}-`)) out.push(join(skills, d));
    out.push(join(root, AGENTS_DIR, `${EXECUTOR_NAME}.md`));
    return out;
  },

  async detach(root): Promise<string[]> {
    const path = join(root, SETTINGS);
    const text = await readText(path);
    if (!text) return [];
    try {
      const settings = JSON.parse(text) as { hooks?: Record<string, HookEntry[]> };
      let touched = false;
      for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
        const kept = entries.filter((e) => !(e.hooks ?? []).some((h) => h.command?.startsWith(`${enforceCommand(null, ID)}`)));
        if (kept.length !== entries.length) {
          settings.hooks![event] = kept;
          touched = true;
        }
      }
      if (!touched) return [];
      writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
      return [`${relative(root, path)}#hooks.PreToolUse`];
    } catch {
      return []; // 不是我们写的 JSON，不动。
    }
  },
};

function executorFile(executor: { def: { name: string; description: string; tools: ToolAction[] }; prompt: string }, _hook: Hook | null): string {
  const tools = executor.def.tools.map((t) => TOOL_NAMES[t]).join(', ');
  return ['---', `name: ${executor.def.name}`, `description: ${executor.def.description}`, `tools: ${tools}`, '---', '', executor.prompt.trim(), ''].join('\n');
}

/**
 * 在现有 settings.json 里加（或保留）执法钩子；其余条目靠命令串识别、逐字节保留（JSON 无注释）。
 * 读不懂的 JSON **不动**：那是有人写过的文件，覆盖它等于把他的钩子删了；投影里就没有我们的钩子，
 * `doctor` 的能力检查会说「声明的执法能力兑不了现」（cli §5.5）。
 */
async function settingsWithHook(path: string, hook: Hook | null): Promise<string> {
  const text = await readText(path);
  let settings: Record<string, unknown> = {};
  if (text) {
    const parsed = parseHostJson(text);
    if (!parsed) return text;
    settings = parsed;
  }
  if (hook) {
    const command = enforceCommand(hook, ID);
    const hooks = (settings['hooks'] as Record<string, HookEntry[]> | undefined) ?? {};
    for (const event of hook.events) {
      const name = HOOK_EVENTS[event];
      const entries = hooks[name] ?? [];
      if (!entries.some((e) => e.hooks?.some((h) => h.command === command))) entries.push({ matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] });
      hooks[name] = entries;
    }
    settings['hooks'] = hooks;
  }
  return JSON.stringify(settings, null, 2) + '\n';
}
