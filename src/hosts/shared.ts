// design: skills §5 — 宿主投影共用：生成物注记、共有文件的标记块合并、宿主描述符的形状。
import type { Executor, Hook, Language, Platform } from '../model/types.js';

export interface SkillSource {
  name: string;
  text: string;
}

export interface HostFile {
  path: string;
  content: string;
}

export const BLOCK_BEGIN = '<!-- XFORGE:BEGIN -->';
export const BLOCK_END = '<!-- XFORGE:END -->';

/** Skill 目录名的前缀：拆除与剪枝按它清扫，旧版本遗留的也一并清掉。 */
export const SKILL_PREFIX = 'xforge';

const NOTE = '<!-- 由 xforge sync 生成；改 xforge/scaffold/ 后重跑，手改会被覆盖 -->';

/** 在 frontmatter 之后插入生成注记（注记放在 frontmatter 之前会破坏它）。 */
export function generatedNote(text: string): string {
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end !== -1) {
      const cut = end + 4;
      return `${text.slice(0, cut)}\n${NOTE}${text.slice(cut)}`;
    }
  }
  return `${NOTE}\n${text}`;
}

/** 共有文件：标记块内替换，块外逐字节保留；没有块就追加到末尾。 */
export function mergeMarkerBlock(existing: string, block: string): string {
  const rendered = `${BLOCK_BEGIN}\n${block}\n${BLOCK_END}`;
  const b = existing.indexOf(BLOCK_BEGIN);
  const e = existing.indexOf(BLOCK_END);
  if (b !== -1 && e !== -1 && e > b) return existing.slice(0, b) + rendered + existing.slice(e + BLOCK_END.length);
  const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${rendered}\n`;
}

/** 拆除：去掉标记块（及其前后各一个换行），块外逐字节保留。 */
export function stripMarkerBlock(existing: string): string {
  const b = existing.indexOf(BLOCK_BEGIN);
  const e = existing.indexOf(BLOCK_END);
  if (b === -1 || e === -1 || e < b) return existing;
  let start = b;
  let end = e + BLOCK_END.length;
  if (existing[end] === '\n') end += 1;
  if (start > 0 && existing[start - 1] === '\n') start -= 1;
  return existing.slice(0, start) + existing.slice(end);
}

export function hasMarkerBlock(text: string): boolean {
  return text.includes(BLOCK_BEGIN);
}

/**
 * 宿主能力。执法与隔离都**不是语义**：`隔离是优化不是语义` —— 没有隔离的宿主上产出逐字节相同。
 * 但 `enforcement` 是事实，`state --orient` 的 0a 段要照实报，报错了就是骗人。
 */
export interface HostCapabilities {
  /** `hook` = 这个宿主有工具调用前的钩子机制，能装上执法；`none` = 装不上，写入范围由人复核。 */
  enforcement: 'hook' | 'none';
  /** 能不能把一站派给隔离子 Agent（入口按 `orient.stage.isolate` 决定用不用）。 */
  isolation: boolean;
}

/**
 * 探测一个宿主在不在。两路证据：
 * - `binaries`：PATH 上的可执行文件（不在 PATH ≠ 没装，所以探测结果是提示不是判决）
 * - `sessionEnv`：宿主会话注入的环境变量，在谁的会话里跑谁就确定在场
 * - `homeConfigDir`：宿主在用户主目录下的配置目录名（`~/.claude`），存在即强证据
 */
export interface HostDetection {
  binaries: string[];
  sessionEnv: string[];
  homeConfigDir: string;
}

export interface ProjectionContext {
  root: string;
  skills: readonly SkillSource[];
  executor: { def: Executor; prompt: string } | null;
  language: Language;
  /** 执法钩子声明（`scaffold/hooks/enforce.yaml`）。没有钩子机制的宿主忽略它。 */
  hook: Hook | null;
}

/**
 * 一个宿主适配器。加一个宿主 = 一个文件 + 四处登记（`types.ts` 的 union、`manifest.schema.json`
 * 的 enum、`registry.ts` 一行、必要时 `src/enforce/hosts/` 一个协议文件），`src/` 其余部分不动。
 */
export interface HostProvider {
  id: Platform;
  /** 交互选择列表里的名字。 */
  label: string;
  /** 选中之后跟在后面的备注，一句话说清投影什么、不投影什么。 */
  note: string;
  capabilities: HostCapabilities;
  /** 执法钩子落在哪个**宿主共享文件**里（相对项目根）；`enforcement: 'none'` 的宿主没有这一项。 */
  hookFile?: string;
  detection: HostDetection;
  /** 投影：写这个宿主的原生文件。 */
  files(ctx: ProjectionContext): Promise<HostFile[]>;
  /** 本宿主在项目里占用的路径（绝对路径，文件或目录）；拆除与剪枝据此清理。 */
  ownership(root: string): Promise<string[]>;
  /** 原地拆解宿主共享文件里属于我们的痕迹（如 `settings.json` 的钩子、`AGENTS.md` 的标记块）。 */
  detach(root: string): Promise<string[]>;
}

/** 执法钩子的命令行：声明里写 `${platform}`，这里代入宿主 id。 */
export function enforceCommand(hook: Hook | null, id: Platform): string {
  const template = hook?.command ?? 'xforge-enforce --host ${platform}';
  return template.replace(/\$\{platform\}/g, id);
}

/** 我们的声明词汇 → 宿主配置里的钩子事件名。两个宿主的叫法一样，共用一张表。 */
export const HOOK_EVENTS: Record<Hook['events'][number], string> = { 'pre-tool-use': 'PreToolUse' };

/** 宿主配置里的一条钩子条目（`settings.json` 与 `hooks.json` 同形）。 */
export interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

/** 读宿主共享文件：只有 JSON 对象算读懂了，数组、标量、解析不了的都是「读不懂」（读不懂就不动它）。 */
export function parseHostJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
