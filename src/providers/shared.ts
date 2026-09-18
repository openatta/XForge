// design: skills §5 — 宿主投影共用：生成物注记、共有文件的标记块合并。
export interface SkillSource {
  name: string;
  text: string;
}

export interface HostFile {
  path: string;
  content: string;
  /** 与人共用的文件：只有标记块（或我们那条记录）归我们，孤儿时摘掉自己的那块而不是删文件。 */
  shared?: boolean;
}

export const BLOCK_BEGIN = '<!-- XFORGE:BEGIN -->';
export const BLOCK_END = '<!-- XFORGE:END -->';
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
