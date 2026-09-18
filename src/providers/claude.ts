// design: cli §5 — claude provider：Skill 到 .claude/skills，执行者到 .claude/agents，执法钩子到 .claude/settings.json。
import { join } from 'node:path';
import { readText } from '../fs/transaction.js';
import { generatedNote, scanHostDir, type HostFile } from './shared.js';
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

  async footprint(root: string): Promise<Array<{ path: string; kind: 'owned' | 'shared' }>> {
    const out = scanHostDir(root, '.claude', 'xforge-executor.md');
    const settings = join(root, '.claude', 'settings.json');
    if ((await enforceEntries(settings)).some((c) => isEnforceCommand(c))) out.push({ path: settings, kind: 'shared' });
    return out;
  },

  async hookBlocked(root: string): Promise<string | null> {
    const path = join(root, '.claude', 'settings.json');
    return (await readSettings(path)) === null ? path : null;
  },

  async detach(root: string, path: string): Promise<HostFile | null> {
    if (path !== join(root, '.claude', 'settings.json')) return null;
    const settings = await readSettings(path);
    if (settings === null) return null; // 读不懂就不动（同 settingsWithHook）
    const hooks = settings['hooks'] as Record<string, HookEntry[]> | undefined;
    if (!hooks?.['PreToolUse']) return null;
    const kept = hooks['PreToolUse'].filter((e) => !(e.hooks ?? []).some((h) => isEnforceCommand(h.command)));
    // 空壳也是痕迹：我们进来之前没有 `hooks.PreToolUse: []`，走的时候就不该留下一个。
    if (kept.length) hooks['PreToolUse'] = kept;
    else delete hooks['PreToolUse'];
    if (!Object.keys(hooks).length) delete settings['hooks'];
    return { path, content: JSON.stringify(settings, null, 2) + '\n', shared: true };
  },
};

async function enforceEntries(path: string): Promise<string[]> {
  const settings = await readSettings(path);
  const pre = (settings?.['hooks'] as Record<string, HookEntry[]> | undefined)?.['PreToolUse'] ?? [];
  return pre.flatMap((e) => (e.hooks ?? []).map((h) => h.command)).filter((c) => typeof c === 'string');
}

/**
 * 读宿主共享配置。不在 → `{}`（我们来建）；在、但解析不成 JSON 对象 → `null`，意思是**读不懂**。
 * 读不懂与空对象必须分开：当成空对象往下走，下一步就是拿一份只含我们钩子的内容覆盖掉
 * 人家的 `permissions` 与其余钩子（命令行设计 §5.2、`CLI-23`）。
 */
async function readSettings(path: string): Promise<Record<string, unknown> | null> {
  const text = await readText(path);
  if (text === null) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 在现有 settings.json 里放（或更新）执法钩子：我们自己那条以外的内容逐字节保留。
 * JSON 没有注释，标记块用不了；靠命令串前缀认自己写的那条，换了声明也能替换掉旧的。
 * 读不懂时原样回传，于是 `sync` 比出来没变化、一个字节都不写。
 */
async function settingsWithHook(path: string, command: string): Promise<string> {
  const settings = await readSettings(path);
  if (settings === null) return (await readText(path)) ?? '';
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
