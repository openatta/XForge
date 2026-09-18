// design: cli §5 — claude provider：Skill 到 .claude/skills，执行者到 .claude/agents，执法钩子到 .claude/settings.json。
import { join } from 'node:path';
import { readText } from '../fs/transaction.js';
import { generatedNote, type HostFile } from './shared.js';
import type { Provider, ProjectionInput } from './index.js';

/** 钩子命令串都以它开头；换了声明也要能认出旧的那条并替换掉。 */
const ENFORCE_PREFIX = 'xforge-enforce';

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

export const claudeProvider: Provider = {
  id: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  capabilities: { enforcement: true, isolation: true },

  async project(input: ProjectionInput): Promise<HostFile[]> {
    const out: HostFile[] = [];
    for (const s of input.skills) out.push({ path: join(input.root, '.claude', 'skills', s.name, 'SKILL.md'), content: generatedNote(s.text) });
    if (input.executor) {
      const tools = input.executor.def.tools.map((t) => ({ read: 'Read, Glob, Grep', write: 'Write', edit: 'Edit, MultiEdit', shell: 'Bash' })[t]).join(', ');
      const body = ['---', `name: ${input.executor.def.name}`, `description: ${input.executor.def.description}`, `tools: ${tools}`, '---', '', input.executor.prompt.trim(), ''].join('\n');
      out.push({ path: join(input.root, '.claude', 'agents', `${input.executor.def.name}.md`), content: generatedNote(body) });
    }
    if (input.hookCommand) {
      const path = join(input.root, '.claude', 'settings.json');
      out.push({ path, content: await settingsWithHook(path, input.hookCommand), shared: true });
    }
    return out;
  },

  async hookInstalled(root: string, command: string | null): Promise<boolean> {
    if (!command) return false;
    return (await enforceEntries(join(root, '.claude', 'settings.json'))).some((c) => c === command);
  },

  async detach(root: string, path: string): Promise<HostFile | null> {
    if (path !== join(root, '.claude', 'settings.json')) return null;
    const settings = await readSettings(path);
    const hooks = settings['hooks'] as Record<string, HookEntry[]> | undefined;
    if (!hooks?.['PreToolUse']) return null;
    hooks['PreToolUse'] = hooks['PreToolUse'].filter((e) => !(e.hooks ?? []).some((h) => isEnforceCommand(h.command)));
    return { path, content: JSON.stringify(settings, null, 2) + '\n', shared: true };
  },
};

async function enforceEntries(path: string): Promise<string[]> {
  const settings = await readSettings(path);
  const pre = (settings['hooks'] as Record<string, HookEntry[]> | undefined)?.['PreToolUse'] ?? [];
  return pre.flatMap((e) => (e.hooks ?? []).map((h) => h.command)).filter((c) => typeof c === 'string');
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  const text = await readText(path);
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 在现有 settings.json 里放（或更新）执法钩子：我们自己那条以外的内容逐字节保留。
 * JSON 没有注释，标记块用不了；靠命令串前缀认自己写的那条，换了声明也能替换掉旧的。
 */
async function settingsWithHook(path: string, command: string): Promise<string> {
  const settings = await readSettings(path);
  const hooks = (settings['hooks'] as Record<string, HookEntry[]> | undefined) ?? {};
  const pre = (hooks['PreToolUse'] ?? []).filter((e) => !(e.hooks ?? []).some((h) => h.command?.startsWith(ENFORCE_PREFIX)));
  pre.push({ matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] });
  hooks['PreToolUse'] = pre;
  settings['hooks'] = hooks;
  return JSON.stringify(settings, null, 2) + '\n';
}

/** 拆除用：这条 PreToolUse 记录是不是我们投的。 */
export function isEnforceCommand(command: string | undefined): boolean {
  return typeof command === 'string' && command.startsWith(ENFORCE_PREFIX);
}
