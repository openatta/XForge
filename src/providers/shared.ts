// design: skills §5 — 宿主投影共用：生成物注记、共有文件的标记块合并、台账不在时的兜底扫描。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillSource {
  name: string;
  text: string;
}

export interface HostFile {
  path: string;
  content: string;
  /** 与人共用的文件：只有标记块（或我们那条记录）归我们，孤儿时摘掉自己的那块而不是删文件。 */
  shared?: boolean;
  /** 这份文件用哪对标记划出我们那块；不给就是 Markdown 的 HTML 注释。TOML 之类要用自己的注释语法。 */
  markers?: { begin: string; end: string };
}

export const BLOCK_BEGIN = '<!-- XFORGE:BEGIN -->';
export const BLOCK_END = '<!-- XFORGE:END -->';
/** TOML 没有 HTML 注释，用它自己的 `#`。形状一样：一对标记，块外逐字节不动。 */
export const TOML_MARKERS = { begin: '# XFORGE:BEGIN', end: '# XFORGE:END' } as const;
/** 生成物的头注记。也是「这份文件是我投的」的凭据：兜底扫描按它认，而不是按目录名猜。 */
export const NOTE = '<!-- 由 xforge sync 生成；改 xforge/scaffold/ 后重跑，手改会被覆盖 -->';

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
export function mergeMarkerBlock(existing: string, block: string, marks: { begin: string; end: string } = { begin: BLOCK_BEGIN, end: BLOCK_END }): string {
  const { begin: BLOCK_BEGIN, end: BLOCK_END } = marks;
  const rendered = `${BLOCK_BEGIN}\n${block}\n${BLOCK_END}`;
  const b = existing.indexOf(BLOCK_BEGIN);
  const e = existing.indexOf(BLOCK_END);
  if (b !== -1 && e !== -1 && e > b) return existing.slice(0, b) + rendered + existing.slice(e + BLOCK_END.length);
  const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${rendered}\n`;
}

/** Skill 目录名的前缀：`xforge` 与 `xforge-*`。兜底扫描按它认自己投过的目录。 */
export const SKILL_PREFIX = 'xforge';

/**
 * 按已知布局扫这个宿主目录下属于我们的文件：`<host>/skills/xforge*` 与执行者定义里，
 * **头上带生成注记的那些**。台账在的时候用不上它 —— 这是台账不在时的兜底（命令行设计 `CLI-46`）。
 *
 * 为什么还要看内容：删文件的依据不能是「名字像我们的」。有人手写一个 `.claude/skills/xforge-mine/`
 * 完全合法，按前缀猜就把它删了。带注记 = 这一份确实是 `sync` 写出去的。
 */
export function scanHostDir(root: string, hostDir: string, executor: string | null): Array<{ path: string; kind: 'owned' | 'shared' }> {
  const out: Array<{ path: string; kind: 'owned' | 'shared' }> = [];
  const skills = join(root, hostDir, 'skills');
  if (existsSync(skills)) {
    for (const name of readdirSync(skills).sort()) {
      if (name !== SKILL_PREFIX && !name.startsWith(`${SKILL_PREFIX}-`)) continue;
      for (const file of filesUnder(join(skills, name))) if (isGenerated(file)) out.push({ path: file, kind: 'owned' });
    }
  }
  if (executor) {
    const agent = join(root, hostDir, 'agents', executor);
    if (existsSync(agent) && isGenerated(agent)) out.push({ path: agent, kind: 'owned' });
  }
  return out;
}

/** 这份文件是不是 `sync` 写出去的：头注记在，就是。 */
function isGenerated(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(NOTE);
  } catch {
    return false;
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** 拆除：去掉标记块（及其前后各一个换行），块外逐字节保留。 */
export function stripMarkerBlock(existing: string, marks: { begin: string; end: string } = { begin: BLOCK_BEGIN, end: BLOCK_END }): string {
  const { begin: BLOCK_BEGIN, end: BLOCK_END } = marks;
  const b = existing.indexOf(BLOCK_BEGIN);
  const e = existing.indexOf(BLOCK_END);
  if (b === -1 || e === -1 || e < b) return existing;
  let start = b;
  let end = e + BLOCK_END.length;
  if (existing[end] === '\n') end += 1;
  if (start > 0 && existing[start - 1] === '\n') start -= 1;
  return existing.slice(0, start) + existing.slice(end);
}
